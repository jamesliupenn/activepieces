import { apAxios, AppSystemProp, GetRunForWorkerRequest, JobStatus, QueueName, UpdateFailureCountRequest, UpdateJobRequest } from '@activepieces/server-shared'
import { ActivepiecesError, ApEdition, ApEnvironment, assertNotNullOrUndefined, EngineHttpResponse, EnginePrincipal, ErrorCode, FileType, FlowRunResponse, FlowRunStatus, GetFlowVersionForWorkerRequest, isNil, ListFlowsRequest, NotifyFrontendRequest, PauseType, PlatformUsageMetric, PopulatedFlow, PrincipalType, ProgressUpdateType, SendFlowResponseRequest, UpdateRunProgressRequest, UpdateRunProgressResponse, WebsocketClientEvent } from '@activepieces/shared'
import { FastifyPluginAsyncTypebox, Type } from '@fastify/type-provider-typebox'
import { FastifyBaseLogger } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { entitiesMustBeOwnedByCurrentProject } from '../authentication/authorization'
import { domainHelper } from '../ee/custom-domains/domain-helper'
import { projectLimitsService } from '../ee/projects/project-plan/project-plan.service'
import { fileService } from '../file/file.service'
import { flowService } from '../flows/flow/flow.service'
import { flowRunService } from '../flows/flow-run/flow-run-service'
import { flowVersionService } from '../flows/flow-version/flow-version.service'
import { system } from '../helper/system/system'
import { flowConsumer } from './consumer'
import { engineResponseWatcher } from './engine-response-watcher'

export const flowEngineWorker: FastifyPluginAsyncTypebox = async (app) => {

    app.addHook('preSerialization', entitiesMustBeOwnedByCurrentProject)

    app.get('/runs/:runId', {
        config: {
            allowedPrincipals: [PrincipalType.ENGINE],
        },
        schema: {
            params: GetRunForWorkerRequest,
        },
    }, async (request) => {
        const { runId } = request.params
        return flowRunService(request.log).getOnePopulatedOrThrow({
            id: runId,
            projectId: request.principal.projectId,
        })
    })

    app.get('/populated-flows', GetAllFlowsByProjectParams, async (request) => {
        return flowService(request.log).list({
            projectId: request.principal.projectId,
            limit: request.query.limit ?? 1000000,
            cursorRequest: request.query.cursor ?? null,
            folderId: request.query.folderId,
            status: request.query.status,
            name: request.query.name,
            versionState: request.query.versionState,
            connectionExternalIds: request.query.connectionExternalIds,
            agentExternalIds: request.query.agentExternalIds,
            externalIds: request.query.externalIds,
        })
    })

    app.post('/update-job', {
        config: {
            allowedPrincipals: [PrincipalType.ENGINE],
        },
        schema: {
            body: UpdateJobRequest,
        },
    }, async (request) => {
        const environment = system.getOrThrow(AppSystemProp.ENVIRONMENT)
        if (environment === ApEnvironment.TESTING) {
            return {}
        }
        const enginePrincipal = request.principal as unknown as EnginePrincipal
        assertNotNullOrUndefined(enginePrincipal.queueToken, 'queueToken')
        const { id } = request.principal
        const { queueName, status, message } = request.body
        await flowConsumer(request.log).update({ jobId: id, queueName, status, message: message ?? 'NO_MESSAGE_AVAILABLE', token: enginePrincipal.queueToken })
        return {}
    })

    app.post('/update-failure-count', UpdateFailureCount, async (request) => {
        const { flowId, projectId, success } = request.body
        await flowService(request.log).updateFailureCount({
            flowId,
            projectId,
            success,
        })
    })

    app.post('/notify-frontend', NotifyFrontendParams, async (request) => {
        const { type, data } = request.body
        app.io.to(request.principal.projectId).emit(type, data)
    })

    app.post('/update-run', UpdateRunProgress, async (request) => {
        const { runId, workerHandlerId, runDetails, httpRequestId, executionStateBuffer, executionStateContentLength, failedStepName: failedStepName } = request.body
        const progressUpdateType = request.body.progressUpdateType ?? ProgressUpdateType.NONE

        const nonSupportedStatuses = [FlowRunStatus.RUNNING, FlowRunStatus.SUCCEEDED, FlowRunStatus.PAUSED]
        if (!nonSupportedStatuses.includes(runDetails.status) && !isNil(workerHandlerId) && !isNil(httpRequestId)) {
            await engineResponseWatcher(request.log).publish(
                httpRequestId,
                workerHandlerId,
                await getFlowResponse(runDetails),
            )
        }

        const runWithoutSteps = await flowRunService(request.log).updateRun({
            flowRunId: runId,
            status: runDetails.status,
            tasks: runDetails.tasks,
            duration: runDetails.duration,
            projectId: request.principal.projectId,
            tags: runDetails.tags ?? [],
            failedStepName,
        })

        let uploadUrl: string | undefined
        const updateLogs = !isNil(executionStateContentLength) && executionStateContentLength > 0
        if (updateLogs) {
            uploadUrl = await flowRunService(request.log).updateLogsAndReturnUploadUrl({
                flowRunId: runId,
                logsFileId: runWithoutSteps.logsFileId ?? undefined,
                projectId: request.principal.projectId,
                executionStateString: executionStateBuffer,
                executionStateContentLength,
            })
        }
        else {
            app.io.to(request.principal.projectId).emit(WebsocketClientEvent.FLOW_RUN_PROGRESS, runId)
        }

        if (runDetails.status === FlowRunStatus.PAUSED) {
            await flowRunService(request.log).pause({
                flowRunId: runId,
                pauseMetadata: {
                    progressUpdateType,
                    handlerId: workerHandlerId ?? undefined,
                    ...(runDetails.pauseMetadata!),
                },
            })
        }
        await markJobAsCompleted(runWithoutSteps.status, runWithoutSteps.id, request.principal as unknown as EnginePrincipal, runDetails.error, request.log)
        const shouldMarkParentAsFailed = runWithoutSteps.failParentOnFailure && !isNil(runWithoutSteps.parentRunId) && ![FlowRunStatus.SUCCEEDED, FlowRunStatus.RUNNING, FlowRunStatus.PAUSED, FlowRunStatus.QUEUED].includes(runWithoutSteps.status)
        if (shouldMarkParentAsFailed) {
            await markParentRunAsFailed({
                parentRunId: runWithoutSteps.parentRunId!,
                childRunId: runWithoutSteps.id,
                projectId: request.principal.projectId,
                platformId: request.principal.platform.id,
                log: request.log,
            })
        }
        const response: UpdateRunProgressResponse = {
            uploadUrl,
        }
        return response
    })

    app.post('/update-flow-response', UpdateFlowResponseParams, async (request) => {
        const { workerHandlerId, httpRequestId, runResponse } = request.body

        await engineResponseWatcher(request.log).publish(
            httpRequestId,
            workerHandlerId,
            runResponse,
        )
        return {}
    })

    app.get('/check-task-limit', CheckTaskLimitParams, async (request) => {
        const edition = system.getEdition()
        if (edition === ApEdition.COMMUNITY) {
            return {}
        }
        const exceededLimit = await projectLimitsService(request.log).checkTasksExceededLimit(request.principal.projectId)
        if (exceededLimit) {
            throw new ActivepiecesError({
                code: ErrorCode.QUOTA_EXCEEDED,
                params: {
                    metric: PlatformUsageMetric.TASKS,
                },
            })
        }
        return {}
    })

    app.get('/flows', GetLockedVersionRequest, async (request) => {
        const populatedFlow = await getFlow(request.principal.projectId, request.query, request.log)
        return {
            ...populatedFlow,
            version: await flowVersionService(request.log).lockPieceVersions({
                flowVersion: populatedFlow.version,
                projectId: request.principal.projectId,
            }),
        }
    })

    app.get('/files/:fileId', GetFileRequestParams, async (request, reply) => {
        const { fileId } = request.params
        const { data } = await fileService(request.log).getDataOrThrow({
            fileId,
            type: FileType.PACKAGE_ARCHIVE,
        })
        return reply
            .type('application/zip')
            .status(StatusCodes.OK)
            .send(data)
    })



}

async function getFlowResponse(
    result: FlowRunResponse,
): Promise<EngineHttpResponse> {
    switch (result.status) {
        case FlowRunStatus.INTERNAL_ERROR:
            return {
                status: StatusCodes.INTERNAL_SERVER_ERROR,
                body: {
                    message: 'An internal error has occurred',
                },
                headers: {},
            }
        case FlowRunStatus.FAILED:
        case FlowRunStatus.MEMORY_LIMIT_EXCEEDED:
            return {
                status: StatusCodes.INTERNAL_SERVER_ERROR,
                body: {
                    message: 'The flow has failed and there is no response returned',
                },
                headers: {},
            }
        case FlowRunStatus.TIMEOUT:
            return {
                status: StatusCodes.GATEWAY_TIMEOUT,
                body: {
                    message: 'The request took too long to reply',
                },
                headers: {},
            }
        case FlowRunStatus.QUOTA_EXCEEDED:
            return {
                status: StatusCodes.NO_CONTENT,
                body: {},
                headers: {},
            }
        // Case that should be handled before
        default:
            throw new Error(`Unexpected flow run status: ${result.status}`)
    }
}

async function getFlow(projectId: string, request: GetFlowVersionForWorkerRequest, log: FastifyBaseLogger): Promise<PopulatedFlow> {
    // TODO this can be optimized by getting the flow version directly
    const flowVersion = await flowVersionService(log).getOneOrThrow(request.versionId)
    return flowService(log).getOnePopulatedOrThrow({
        id: flowVersion.flowId,
        projectId,
        versionId: request.versionId,
    })
}

async function markJobAsCompleted(status: FlowRunStatus, jobId: string, enginePrincipal: EnginePrincipal, error: unknown, log: FastifyBaseLogger): Promise<void> {
    switch (status) {
        case FlowRunStatus.FAILED:
        case FlowRunStatus.TIMEOUT:
        case FlowRunStatus.PAUSED:
        case FlowRunStatus.QUOTA_EXCEEDED:
        case FlowRunStatus.MEMORY_LIMIT_EXCEEDED:
        case FlowRunStatus.SUCCEEDED:
            await flowConsumer(log).update({ jobId, queueName: QueueName.ONE_TIME, status: JobStatus.COMPLETED, token: enginePrincipal.queueToken!, message: 'Flow succeeded' })
            break
        case FlowRunStatus.QUEUED:
        case FlowRunStatus.RUNNING:
            break
        case FlowRunStatus.INTERNAL_ERROR:
            await flowConsumer(log).update({ jobId, queueName: QueueName.ONE_TIME, status: JobStatus.FAILED, token: enginePrincipal.queueToken!, message: `Internal error reported by engine: ${JSON.stringify(error)}` })
    }
}

async function markParentRunAsFailed({  
    parentRunId,
    childRunId,
    projectId,
    platformId,
    log,
}: MarkParentRunAsFailedParams): Promise<void> {
    const flowRun = await flowRunService(log).getOneOrThrow({
        id: parentRunId,
        projectId,
    })

    const requestId = flowRun.pauseMetadata?.type === PauseType.WEBHOOK ? flowRun.pauseMetadata?.requestId : undefined
    assertNotNullOrUndefined(requestId, 'Parent run has no request id')
    
    const callbackUrl = await domainHelper.getPublicApiUrl({ path: `/v1/flow-runs/${parentRunId}/requests/${requestId}`, platformId })
    const childRunUrl = await domainHelper.getPublicUrl({ path: `/projects/${projectId}/runs/${childRunId}`, platformId })
    await apAxios.post(callbackUrl, {
        status: 'error',
        data: {
            message: 'Subflow execution failed',
            link: childRunUrl,
        },
    })
}

type MarkParentRunAsFailedParams = {
    parentRunId: string
    childRunId: string
    projectId: string
    platformId: string
    log: FastifyBaseLogger
}

const GetAllFlowsByProjectParams = {
    config: {
        allowedPrincipals: [PrincipalType.ENGINE],
    },
    schema: {
        querystring: Type.Omit(ListFlowsRequest, ['projectId']),
    },
}
const CheckTaskLimitParams = {
    config: {
        allowedPrincipals: [PrincipalType.ENGINE],
    },
    schema: {},
}
const GetFileRequestParams = {
    config: {
        allowedPrincipals: [PrincipalType.ENGINE],
    },
    schema: {
        params: Type.Object({
            fileId: Type.String(),
        }),
    },
}

const NotifyFrontendParams = {
    config: {
        allowedPrincipals: [PrincipalType.ENGINE],
    },
    schema: {
        body: NotifyFrontendRequest,
    },
}

const UpdateRunProgress = {
    config: {
        allowedPrincipals: [PrincipalType.ENGINE],
    },
    schema: {
        body: UpdateRunProgressRequest,
    },
}

const UpdateFailureCount = {
    config: {
        allowedPrincipals: [PrincipalType.ENGINE],
    },
    schema: {
        body: UpdateFailureCountRequest,
    },
}

const GetLockedVersionRequest = {
    config: {
        allowedPrincipals: [PrincipalType.ENGINE],
    },
    schema: {
        querystring: GetFlowVersionForWorkerRequest,
        response: {
            [StatusCodes.OK]: PopulatedFlow,
        },
    },
}

const UpdateFlowResponseParams = {
    config: {
        allowedPrincipals: [PrincipalType.ENGINE],
    },
    schema: {
        body: SendFlowResponseRequest,
    },
}
import { ackMessage, decodeData } from '../middleware.js'
import { PRECONDITION_REQUIRED } from '@liquid-bricks/lib-diagnostics/codes'
import { create as createSubject } from '@liquid-bricks/lib-nats-subject/create/basic'
import { events as natsEvents } from '@liquid-bricks/lib-nats-subject/events/nats'

export const path = createSubject(natsEvents['*'].component_service['*']['*'].exec.componentAgent.cmdRegisterProvidingAgentsComponent.v1['*'])
  .forSubscribe()
  .toObject()

export const spec = {
  decode: [
    decodeData(['agentID', 'hash']),
  ],
  handler: registerProvidingAgentsComponent,
  post: [
    ackMessage,
  ],
}

function registerProvidingAgentsComponent({
  scope: { agentID, hash },
  rootCtx: { diagnostics, connectionRegistry },
}) {
  diagnostics.require(
    typeof agentID === 'string' && agentID.length,
    PRECONDITION_REQUIRED,
    'agentID is required for provider registration',
    { field: 'agentID' },
  )
  diagnostics.require(
    typeof hash === 'string' && hash.length,
    PRECONDITION_REQUIRED,
    'Component hash is required for provider registration',
    { field: 'hash', agentID },
  )

  const connection = connectionRegistry.get(agentID)
  diagnostics.require(
    connection,
    PRECONDITION_REQUIRED,
    'Connection missing for provider registration',
    { agentID, hash },
  )

  connection.providedComponentHashes.add(hash)
  return { agentID, hash }
}

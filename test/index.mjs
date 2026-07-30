import test from 'node:test'
import assert from 'node:assert/strict'

import { PRECONDITION_REQUIRED } from '@liquid-bricks/lib-diagnostics/codes'
import { createNatsIngressRouter } from '../src/index.js'
import { spec as cmdRegisterProvidingAgentsComponentSpec } from '../src/routes/cmd_register_providing_agents_component.js'
import { spec as computeFunctionSpec } from '../src/routes/compute_function.js'

function createDiagnosticsStub() {
  const calls = { info: [], warn: [], require: [], debug: [], invariant: [], error: [] }

  class DiagnosticError extends Error {
    constructor(message, code) {
      super(message)
      this.code = code
    }
  }

  const stub = {
    calls,
    DiagnosticError,
    child() { return stub },
    info(...args) { calls.info.push(args) },
    warn(...args) { calls.warn.push(args) },
    debug(...args) { calls.debug.push(args) },
    invariant(value, code, message, meta) {
      calls.invariant.push({ value, code, message, meta })
      if (!value) throw new DiagnosticError(message, code)
    },
    error(code, message, meta) {
      calls.error.push({ code, message, meta })
      return new DiagnosticError(message, code)
    },
    require(value, code, message, meta) {
      calls.require.push({ value, code, message, meta })
      if (!value) throw new DiagnosticError(message, code)
    },
  }

  return stub
}

test('provider registration records the component hash for the addressed connection', async () => {
  const agentID = 'agent-1'
  const diagnostics = createDiagnosticsStub()
  const connectionRegistry = new Map([
    [agentID, { publish() {}, providedComponentHashes: new Set() }],
  ])

  await cmdRegisterProvidingAgentsComponentSpec.handler({
    scope: { agentID, hash: 'hash-abc' },
    rootCtx: { diagnostics, connectionRegistry },
  })

  assert.ok(connectionRegistry.get(agentID).providedComponentHashes.has('hash-abc'))
})

test('NATS ingress routes acknowledge through post hooks', () => {
  let acknowledgments = 0
  const message = { ack: () => { acknowledgments += 1 } }

  for (const routeSpec of [computeFunctionSpec, cmdRegisterProvidingAgentsComponentSpec]) {
    assert.equal(routeSpec.post.length, 1)
    routeSpec.post[0]({ message })
  }

  assert.equal(acknowledgments, 2)
})

test('compute_function publishes through the provider registered for the component hash', async () => {
  const diagnostics = createDiagnosticsStub()
  const publishCalls = []
  const connectionRegistry = new Map([
    [1, { publish: (...args) => publishCalls.push({ connectionId: 1, args }), providedComponentHashes: new Set(['hash-one']) }],
    [2, { publish: (...args) => publishCalls.push({ connectionId: 2, args }), providedComponentHashes: new Set(['hash-two']) }],
  ])
  const scope = {
    instanceId: 'instance-1',
    deps: { foo: 'bar' },
    componentHash: 'hash-two',
    name: 'TestComponent',
    type: 'widget',
  }

  await computeFunctionSpec.handler({
    scope,
    rootCtx: { diagnostics, connectionRegistry },
    routeCtx: computeFunctionSpec.context,
  })

  assert.equal(publishCalls.length, 1)
  const [{ connectionId, args }] = publishCalls
  assert.equal(connectionId, 2)
  const [subject, payload] = args
  assert.equal(subject, 'prod.agent._._.cmd.component.compute_function.v1._')
  assert.deepEqual(payload, {
    componentHash: 'hash-two',
    name: 'TestComponent',
    type: 'widget',
    instanceId: 'instance-1',
    deps: { foo: 'bar' },
  })
})

test('router diagnoses a missing compute_function provider without secondary warnings', async () => {
  const diagnostics = createDiagnosticsStub()
  const natsIngressRouter = createNatsIngressRouter({
    natsContext: {},
    diagnostics,
    connectionRegistry: new Map(),
  })
  const subject = 'prod.gateway._.agent-gw.cmd.component.compute_function.v1._'
  const requestMessage = {
    subject,
    json() {
      return {
        data: {
          instanceId: 'instance-1',
          deps: {},
          componentHash: 'hash-missing',
          name: 'TestComponent',
          type: 'widget',
        },
      }
    },
  }

  await natsIngressRouter.request({ subject, message: requestMessage })

  assert.ok(
    diagnostics.calls.require.some((call) => (
      call.code === PRECONDITION_REQUIRED &&
      call.message === 'No component provider registered for requested hash'
    )),
  )
  assert.equal(diagnostics.calls.warn.length, 0)
  assert.equal(diagnostics.calls.error.length, 0)
})

test('compute_function validation fails when no provider has the requested hash', () => {
  const diagnostics = createDiagnosticsStub()
  const connectionRegistry = new Map([
    [1, { publish() {}, providedComponentHashes: new Set(['hash-one']) }],
  ])

  assert.throws(
    () => computeFunctionSpec.handler({
      scope: { componentHash: 'hash-missing' },
      rootCtx: { diagnostics, connectionRegistry },
      routeCtx: computeFunctionSpec.context,
    }),
    (error) => (
      error instanceof diagnostics.DiagnosticError &&
      error.code === PRECONDITION_REQUIRED
    ),
  )
})

# @flashyos/wdk

The FlashyOS agent object. One interface for the seven things an autonomous
organization does with money on Tether WDK:

```
create an agent → give it an identity → provision financial capabilities
→ set its permissions → let it transact across chains → record what it did
→ coordinate it with other agents
```

```ts
import { FlashyOrganization, HttpTransport } from '@flashyos/wdk';

const org = new FlashyOrganization(new HttpTransport({
  baseUrl: 'https://api.flashyos.com', orgId, sessionToken, signerUrl: 'http://signer.internal:8787',
}));

// create → identity
const procurement = await org.agents.create('procurement', ['wallet:propose', 'wallet:read']);

// provision → permissions (a human act: the transport's session token)
await org.authority.set('procurement', {
  chain: 'evm:84532', kinds: ['transfer'], assets: [USDT], destinations: [VENDOR],
  perTxMax: '100000000', dailyMax: '500000000', autoApproveMax: '25000000',
});

// transact — re-derive → propose → (wait for a human) → execute through the signer
const result = await procurement.wallet.transact('evm:84532', { to: USDT, data: transferCalldata(VENDOR, 12_000_000n) });
// { status: 'executed' | 'refused' | 'escalated' | 'denied' | 'unrecognised', ...reason }

// record
await procurement.memory.record('Paid the data vendor for the September batch.', 'notes/procurement');

// coordinate — invoices in, settlements out, both through the plane
const invoice = await procurement.partners.invoice({ workBroadcastId, chain, asset, amount });
const settled = await procurement.partners.settle({ invoiceId: '…' });

// every verb is one event; one stream per organization
org.events.on('*', (e) => console.log(JSON.stringify(e)));
```

## What it is

- **One object, two sides.** `FlashyOrganization` is what the humans do
  (create agents, set and revoke authority, register addresses, set
  settlement policies, resolve decisions, read the ledger, metrics,
  receivables and receipts). `FlashyAgent` is what an agent does with its own
  token (`authority.delegate`, `wallet.propose/transact/execute/complete`,
  `memory.record`, `partners.invoice/settle`). No method on the agent can
  widen its own authority; no method on the organization moves money.
- **One transport interface, two implementations.** `HttpTransport` talks to
  the FlashyOS API and a signer over the network, with the session token on
  human routes, the agent's token on agent routes, and no bearer at all on
  the signer (the authorization *is* the credential). `InProcessTransport`
  (in `packages/api`) calls the services directly — the demos and the API's
  own tests use it. The object cannot tell them apart.
- **One event system.** Every verb emits exactly one JSON-serializable event
  (`agent.created`, `envelope.set`, `wallet.proposed`, `wallet.allowed`,
  `wallet.escalated`, `wallet.denied`, `wallet.executed`, `wallet.refused`,
  `decision.resolved`, `delegation.created`, `invoice.issued`,
  `settlement.attempted`, `memory.recorded`, …). `org.events.log` is the
  record; `org.events.counts()` is a closing frame.
- **Chain-agnostic at the interface.** `transact(chain, call)` takes an EVM
  transaction, a TRON transaction, or a swap/bridge protocol call; the chain
  id picks the extractor that re-derives what the call actually does. Adding
  a chain WDK reaches is an extractor pack and a signer backend — nothing in
  this package changes.
- **Refusals are values.** `denied` (the plane), `refused` (the signer),
  `escalated` (a human is needed), `unrecognised` (no extractor vouches for
  the call) all come back with a code and a reason. Only a transport failure
  throws, as `TransportError`, and it is never mistaken for a verdict.

## The verbs since Rev E (Phases 17–22)

```ts
// identify — one WDK account per agent; the envelope tree as a Safe allowance plan a person executes
await org.identities.assign('procurement', 'evm');            // { accountIndex: 1, address: null → reported by the signer }
const plan = await org.identities.plan({ safeAddress, moduleAddress, token: USDT, chain: 'evm:84532' });

// meter — a cap under one decision, ticks without one, a close reconciled against the provider's count
const m = await procurement.wallet.meter.open({ chain, asset: USDT, provider: INFERENCE_CO, unit: 'token', cap: '400000' });
await procurement.wallet.meter.tick(m.meter.id, { units: '1000', amount: '60000' });
const closed = await procurement.wallet.meter.close(m.meter.id, { providerUnits: '5010', providerAmount: '302000' });
// closed.authorization → procurement.wallet.execute(closed.authorization, transferCall)

// interoperate — a signed invoice from outside FlashyOS; a plane-signed receipt the payee verifies offline
const paid = await procurement.partners.pay(signedInvoice);   // verdict + settlement; execute the authorization as any transfer
const receipt = await procurement.partners.receipt(signedInvoice.id);
verifyReceipt(receipt, { expectedPayerKey: (await org.publicKey()).publicKey, invoice: signedInvoice }); // { ok: true }

// x402 — a 402 challenge → bounded record → plane → signer signs the EIP-3009 typed data → X-PAYMENT header
const payment = await procurement.wallet.pay402(challengeBody, myAddress);
// { status: 'signed', header, reference: 'eip3009:0x…' } | 'escalated' | 'denied' | 'refused' | 'unrecognised'

// prove — the hash-chained export, sealed; verified with the public key alone
const entries = await org.provenance.export();
const seal = await org.provenance.seal();                      // { seq, root, sig, anchorCalldata }
verifyExport(entries, { root: seal, publicKey });               // { ok: true, entries, root }

// network — count this org's weekly numbers publicly, or not
await org.network.share(true);
const summary = await org.network.summary();                   // sums + contributing count; honest zeros
```

```ts
// federation (Phases 23–26) — two planes, one network
const doc = await org.trust.plane();                              // this plane's /.well-known/flashyos-plane.json
await org.trust.add({ name: 'partner-plane', document: theirDoc }); // OWNER: trust their active keys, fingerprints checked
const inv = await billing.partners.issueSignedInvoice({ chain, asset: USDT, amount: '250000', memo: 'September' }); // under the org's own key, to a registered address
// …the payer, anywhere, pays it with partners.pay(inv.invoice) and hands back partners.receipt(inv.invoiceId)…
await billing.partners.acceptReceipt(theirReceipt);               // PAID only if it verifies under a trusted plane and names this invoice by hash
const challenge = await billing.partners.x402Challenge({ chain, asset: USDT, amount: '5000', resource: 'https://api.acme/report' }); // a 402 that pays to our address
await facilitator.partners.recordX402Settlement({ payment: xPaymentHeader, asset: USDT, txHash, outcome: 'CONFIRMED' }); // wallet:settle
const money = await org.money(7);                                 // the DIGEST page the next compile writes, with claim addresses
```

And `flashyos-run agent.mjs` runs a module's default export `(agent, org) => …`
with the object pre-wired from `FLASHYOS_*` environment variables; every
event is a JSON line on stdout. `examples/procurement.mjs` is a whole agent.

## What it is not

It is not a wallet. It holds no seed and signs nothing; WDK does that,
inside the signer, behind the plane. It is not a security boundary either —
the plane and the signer are. It is the shape that carries an agent's
identity, authority, history and partners through every integration, so that
the thirtieth sees the same agent as the first.

## Proof

`packages/api/src/lib/wallet/demo/week.object.ts` (102 lines) and
`network.object.ts` (180 lines) re-run the four-agent week and the
twenty-organization network through this object and produce the same pinned
closing frames as the service-level originals (382 and 465 lines) —
asserted by `object.integration.test.ts`.

Apache-2.0.

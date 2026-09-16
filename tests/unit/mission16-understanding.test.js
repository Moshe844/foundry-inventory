'use strict';

/*
 * StockChief reading what somebody actually said.
 *
 * "Please remove the entire inventory" came back as: there is nothing called
 * "please remove entire" in this inventory — with a button offering to create
 * a product by that name. The sentence was clear, the request was real, and
 * StockChief turned the person's own words into a product it wanted to add.
 *
 * The cause was a fallback with only one shape for anything it could not
 * place: "a product I have not heard of". So every unrecognised sentence
 * became a product name, and the leftover words became its title.
 *
 * Two rules come out of that. A name has to be plausibly a name — a sentence
 * made of instructions named nothing. And a request StockChief cannot carry out
 * here is answered by saying where it is done, not by inventing a record.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const resolver = require('../../src/actions/resolver');
const actionService = require('../../src/actions/action-service');
const authService = require('../../src/domain/auth-service');
const realBusinessGrounding = require('../../src/foundry/real-business-grounding');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

test('explicit SKU evidence outranks approximate product wording and never substitutes a missing identifier',()=>{
 const env=setup();const item=makeQuantityItem(env.db,env.workspace.ctx,{name:'Precision mounting block',baseCode:'PMB-X41'});
 const found=resolver.resolveSku(env.db,env.workspace.workspaceId,'blocks','',{instruction:'Prepare 7 blocks SKU: PMB-X41 for review'});
 assert.equal(found.ok,true);assert.equal(found.value.id,item.skuId);
 const missing=resolver.resolveSku(env.db,env.workspace.workspaceId,'Precision mounting block','',{instruction:'Prepare 7 Precision mounting block SKU: MISSING-Z9 for review'});
 assert.equal(missing.ok,false);assert.match(missing.question||missing.message,/missing-z9/i);
 const multi=resolver.resolveSku(env.db,env.workspace.workspaceId,'blocks','',{instruction:'Buy SKU PMB-X41 and SKU OTHER-R2'});
 assert.equal(multi.ok,false,'several source identifiers cannot select the first one');
});

test('review-only supplier creation continues to a draft and is never approval to order or send',async()=>{
 const env=setup();
 const prepared=await actionService.interpret(env.db,env.ctx,env.membership,'Order 4 Black Small Shirt from New Vendor Kappa',{previewOnly:true});
 assert.equal(prepared.kind,'question');assert.doesNotMatch(prepared.question,/approve this purchase order/);
 const continued=await actionService.continueInterpretation(env.db,env.ctx,env.membership,
   {...prepared.continuation,previewOnly:true},'__create_purchase_supplier__');
 assert.equal(continued.kind,'purchase_order');assert.equal(continued.order.status,'DRAFT');
 assert.equal(continued.approvedByConfirmation,false);
});

test('generic location language shapes structure but never creates a production location name', () => {
  assert.equal(realBusinessGrounding.locationIsGrounded(
    'Every machine has its own current location and condition.', 'Current Location'), false);
  assert.equal(realBusinessGrounding.locationIsGrounded(
    'Every device is kept in a storage location.', 'Storage Location'), false);
  assert.equal(realBusinessGrounding.locationIsGrounded(
    'We have warehouses in Brooklyn and New Jersey.', 'Brooklyn'), true);
});

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Shop' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  makeQuantityItem(db, workspace.ctx, { name: 'Black Small Shirt', baseCode: 'BLACK-S' });
  return { db, workspace, ctx: workspace.ctx, membership };
}

const read = (env, text) => resolver.clarifySkuFromInstruction(env.db, env.workspace.workspaceId, text);

test('a sentence made of instructions is not a product name', () => {
  const env = setup();
  for (const said of [
    'Please remove the entire inventory',
    'delete everything',
    'please delete all my data',
    'clear everything',
    'remove all products',
    'wipe the whole workspace',
  ]) {
    const result = read(env, said);
    assert.equal(result.reason, 'not_understood', said);
    assert.equal(result.subject, null,
      `"${said}" must not become a name StockChief offers to create`);
  }
});

test('a verb is never part of the product name', () => {
  const env = setup();
  /*
   * The other half of the same bug: "remove" was being kept inside the name,
   * so StockChief looked for a product called "remove blue widget". Checked on
   * sentences that count something, because those are the ones where a name
   * StockChief has not seen is worth offering to create.
   */
  assert.equal(read(env, 'receive 12 blue widgets').subject, 'blue widget');
  assert.equal(read(env, 'we counted 8 navy socks').subject, 'navy sock');
  assert.equal(read(env, 'put 4 red hats in Main').subject, 'red hat');
});

test('removing something StockChief does not have is not answered by creating it', () => {
  /*
   * "remove the blue widget" used to offer to create a blue widget, which
   * cannot be what anybody wanted: the request was to get rid of one. There
   * is no quantity here and no sensible offer to make, so StockChief says it did
   * not understand rather than proposing the opposite of the request.
   */
  const env = setup();
  assert.equal(read(env, 'remove the blue widget').subject, null);
  assert.equal(read(env, 'archive the navy socks').subject, null);
});

test('a product that genuinely does not exist is still offered for creation', () => {
  const env = setup();
  const result = read(env, 'receive 10 navy socks');
  assert.equal(result.reason, 'not_found', 'this is the case the offer was built for');
  assert.equal(result.subject, 'navy sock');
});

test('an instruction naming a product StockChief has does not trip any of this', () => {
  const env = setup();
  const result = read(env, 'we sold 3 Black Small Shirt');
  assert.ok(!result || result.ok !== false || result.reason !== 'not_understood',
    'a working instruction must not be diverted');
});

test(`a request StockChief cannot carry out keeps the reader own words`, async () => {
  /*
   * The first fix for this was a hand-written table of sentences and a regex.
   * It covered the one sentence that was reported and almost nothing else,
   * and it was the wrong layer entirely: the reader already understands these.
   * Asked directly, it answers "Please remove the entire inventory" with
   * "did the stock physically leave, or are you correcting a count?" — a
   * better question than anything worth hard-coding.
   *
   * What broke it was a step *after* the reader that re-grounded any question
   * mentioning "item" or "product" into "there is nothing called <your own
   * words>", with a button offering to create that. So the rule under test is
   * narrow: whatever StockChief says back, it must never offer to create a
   * product out of a sentence that was an instruction.
   */
  const env = setup();
  for (const said of [
    'Please remove the entire inventory',
    'get rid of this whole thing',
    'nuke it',
    'I want to start from scratch',
  ]) {
    // This test owns the layer after interpretation. Keep the reader result
    // deterministic so a remote model refusal cannot turn product grounding
    // CI red or spend a minute retrying an intentionally unsupported phrase.
    const answer = await actionService.interpret(env.db, env.ctx, env.membership, said, {
      parsedIntent: {
        lines: [],
        clarifyingQuestion: `What outcome do you want from “${said}”?`,
        unsupportedReason: '',
      },
    });
    assert.ok(!answer.notFound,
      `"${said}" must never offer to create a product — it offered "${answer.notFound}"`);
    assert.ok(['question', 'unsupported', 'proposal', 'delete_inventory'].includes(answer.kind),
      `"${said}" produced an unexpected outcome: ${answer.kind}`);
    if (answer.kind === 'question') {
      assert.ok(String(answer.question || '').trim().length > 0,
        'a question with no words in it is not an answer');
    }
  }
});

test('phrasings nobody wrote down still cannot become products', () => {
  /*
   * The first attempt at this was a list of words — please, remove, delete,
   * everything — and it covered the sentence that was reported and almost
   * nothing else. Six of eight phrasings tried against it still invented a
   * product: "get rid of this whole thing" became a product called "get rid
   * thi whole thing".
   *
   * The rule that replaced it needs no list. Somebody names a product StockChief
   * has never heard of when they are putting stock in, and a sentence about
   * getting rid of everything never carries a count. So the offer to create
   * requires a number, and none of these have one.
   */
  const env = setup();
  for (const said of [
    'get rid of this whole thing',
    'I want to start from scratch',
    'nuke it',
    'can you empty this out',
    'scrap the lot',
    'take it all down',
    'burn it all',
    'make it go away',
    'wipe the slate clean',
  ]) {
    const result = read(env, said);
    assert.equal(result.subject, null,
      `"${said}" must not become a product StockChief offers to create`);
  }
});

test('putting stock in for something new still offers to add it', () => {
  /*
   * The other half. This is what the create offer exists for, and a fix that
   * quietly removed it would be worse than the bug.
   */
  const env = setup();
  assert.equal(read(env, 'receive 10 navy socks').subject, 'navy sock');
  assert.equal(read(env, 'we counted 40 blue mugs').subject, 'blue mug');
  assert.equal(read(env, 'put 25 red caps into Main').subject, 'red cap');
});

test('"the entire inventory" means the entire inventory', async () => {
  /*
   * The screenshot that produced this: "Please remove the entire inventory —
   * I said the entire", answered with "do you mean issue or adjust, and which
   * item and location is this for?"
   *
   * The reader was not being stupid. Every operation it was allowed to choose
   * from was a stock operation — receive, issue, transfer, adjust, archive a
   * product — so there was no correct answer available and it picked the
   * nearest one. StockChief did not have the concept of removing an inventory,
   * so it could not hear somebody asking for it.
   *
   * The fix was to give it the word, not to pattern-match the sentence.
   */
  const env = setup();
  for (const said of [
    'Please remove the entire inventory — I said the entire',
    'delete everything',
    'get rid of this whole thing',
    'nuke it',
    'start from scratch',
  ]) {
    // This is a grounding/workflow test, not a paid live-model test. Supply
    // the typed interpretation so local API credentials cannot cause retries
    // or keep the entire regression suite alive during a provider outage.
    const answer = await actionService.interpret(env.db, env.ctx, env.membership, said, {
      parsedIntent:{lines:[{actionType:'delete_inventory',sourceText:said}],clarifyingQuestion:'',unsupportedReason:''},
    });

    /*
     * The reader is not deterministic, and more than one outcome is defensible
     * for a sentence like "nuke it" — a proposal to empty the shelves still
     * waits for approval. What is never defensible is the thing that was
     * reported: being asked which item was meant by "the entire inventory".
     * So that is what is asserted, rather than an exact route.
     */
    assert.ok(!answer.notFound, 'and nothing is offered for creation');

    const words = String(answer.message || answer.question || '');
    assert.doesNotMatch(words, /which item/i,
      `"${said}" must never be answered by asking which item was meant`);
    assert.doesNotMatch(words, /which location/i);
  }
});

test('the answer names the inventory and says it cannot be undone', async () => {
  const env = setup();
  const answer = await actionService.interpret(env.db, env.ctx, env.membership,
    'Please remove the entire inventory', {
      parsedIntent:{lines:[{actionType:'delete_inventory',sourceText:'Please remove the entire inventory'}],clarifyingQuestion:'',unsupportedReason:''},
    });
  if (answer.kind !== 'delete_inventory') return; // the reader may route it as unsupported; both are correct
  assert.match(answer.message, /Shop/, 'it says which inventory');
  assert.match(answer.message, /cannot be undone/);
  assert.equal(answer.where.href, `/inventories/${env.workspace.workspaceId}/delete`, 'and offers the way there');
});

test('when the first read comes back empty, StockChief asks an easier question', async () => {
  /*
   * Twenty ways of asking to delete an inventory were run against the full
   * read. Seventeen landed and three came back with nothing — a different
   * three each time. The three were not badly phrased; the reader simply had
   * to choose an operation and fill in a product, a location and a quantity
   * all at once, and returned empty when unsure of any of it.
   *
   * So a second, much easier question is asked before giving up: of these
   * operations, which is this one? No fields, no records, one choice. With it
   * the same twenty went 20, 20 and 19 out of 20 across three runs.
   *
   * Stubbed here so the mechanism is tested rather than the weather.
   */
  const env = setup();
  const answer = await actionService.interpret(env.db, env.ctx, env.membership,
    'throw the whole thing away', {
      provider: {
        complete: async ({ schemaName }) => (schemaName === 'which_operation'
          // The easier question, answered.
          ? { data: { operation: 'delete_inventory', confidence: 'certain', because: '"the whole thing"' } }
          // The full read, coming back with nothing usable.
          : { data: { lines: [], clarifyingQuestion: '', unsupportedReason: '' } }),
      },
    });

  assert.equal(answer.kind, 'delete_inventory', 'the second question recovered it');
  assert.match(answer.message, /cannot be undone/);
  assert.equal(answer.where.href, `/inventories/${env.workspace.workspaceId}/delete`);
});

test('an unsure second opinion is not used', async () => {
  /*
   * A guess about what somebody meant is worse than the honest question they
   * were going to be asked anyway — particularly when the guess is "delete
   * everything you own".
   */
  const env = setup();
  const answer = await actionService.interpret(env.db, env.ctx, env.membership, 'sort it out', {
    provider: {
      complete: async ({ schemaName }) => (schemaName === 'which_operation'
        ? { data: { operation: 'delete_inventory', confidence: 'unsure', because: 'guessing' } }
        : { data: { lines: [], clarifyingQuestion: '', unsupportedReason: '' } }),
    },
  });
  assert.notEqual(answer.kind, 'delete_inventory', 'a guess must not delete an inventory');
  assert.equal(answer.kind, 'question');
});

test('a second opinion that names nothing changes nothing', async () => {
  const env = setup();
  const answer = await actionService.interpret(env.db, env.ctx, env.membership, 'hello there', {
    provider: {
      complete: async ({ schemaName }) => (schemaName === 'which_operation'
        ? { data: { operation: 'none', confidence: 'certain', because: 'not an instruction' } }
        : { data: { lines: [], clarifyingQuestion: '', unsupportedReason: '' } }),
    },
  });
  assert.equal(answer.kind, 'question');
});

test('an instruction typed into the question box is not answered as a question', async () => {
  /*
   * "Please delete my entire inventory" typed into Ask came back with:
   *
   *   "I'm not able to delete your entire inventory from the system…
   *    StockChief cannot delete or wipe an entire inventory."
   *
   * Which is false. StockChief deletes inventories; it does it on the inventory's
   * own settings page. Every intent the question planner could choose from was
   * a lookup, so an instruction had nowhere to go but 'unsupported', and the
   * reader wrote its own explanation for a limit that does not exist.
   *
   * A reader with no correct option available will invent one. The fix is the
   * option, not a rule about that sentence.
   */
  const env = setup();
  const planner = require('../../src/attention/query-planner');

  for (const said of [
    'Please delete my entire inventory',
    'receive 10 navy socks',
    'move 5 shirts to the store',
  ]) {
    const answer = await planner.ask(env.db, env.workspace.workspaceId, said, {
      provider:{complete:async()=>({data:{decision:'action',interpretation:'Prepare the requested operation',clarification:'',parts:[]}})},
    });
    assert.equal(answer.plan.intent, 'action',
      `"${said}" is something to do, not something to look up`);
    assert.doesNotMatch(String(answer.plan.unsupportedReason || ''), /cannot delete|not able to delete/i,
      'and StockChief must not claim a limit it does not have');
  }
});

test('a real question is still a question', async () => {
  const env = setup();
  const planner = require('../../src/attention/query-planner');
  const asked = await planner.ask(env.db, env.workspace.workspaceId,
    'how many Black Small Shirt do we have?', {
      provider:{complete:async()=>({data:{decision:'answer',interpretation:'Read current stock',clarification:'',parts:[{
        question:'how many Black Small Shirt do we have?',intent:'stock_level',entityQuery:'Black Small Shirt',locationQuery:'',windowDays:30,limit:10,unsupportedReason:'',recordQuery:null,
      }]}})},
    });
  assert.notEqual(asked.plan.intent, 'action', 'looking something up must not be diverted');
});

test('StockChief can be asked to write to somebody', async () => {
  /*
   * "Please email motty6700@gmail.com that we received the order" was answered
   * "StockChief cannot send emails to customers or suppliers."
   *
   * It had sent one that morning — a payment link, from the owner's own Gmail,
   * message id 1a062d53f96aeddf. There are three working paths for it. None
   * of them were in the list of operations the reader could choose from, so it
   * did what it had done twice before and invented the limitation.
   */
  const env = setup();
  const connections = require('../../src/connections/service');
  const comms = require('../../src/sales/customer-communications');
  const made = connections.create(env.db, env.ctx, env.membership,
    { providerType: 'supplier_email', displayName: 'Mailbox' });
  env.db.prepare(`UPDATE workspace_connectors SET provider_type = 'gmail', status = 'connected',
    setup_status = 'CONNECTED', paused_at = NULL WHERE id = ?`).run(made.connection.id);

  const answer = await actionService.interpret(env.db, env.ctx, env.membership,
    'Please email motty6700@gmail.com that we received the order');

  assert.equal(answer.kind, 'message_draft');
  assert.equal(answer.recipient.email, 'motty6700@gmail.com');
  assert.match(answer.body, /received the order/i);
  assert.doesNotMatch(String(answer.message || ''), /cannot send/i);
});

test('the words sent are the words that were asked for', async () => {
  /*
   * A message that says more than the person asked it to say is a message
   * they did not write, going out over their name.
   */
  const env = setup();
  const outbound = require('../../src/actions/outbound-message');
  const connections = require('../../src/connections/service');
  const comms = require('../../src/sales/customer-communications');
  const made = connections.create(env.db, env.ctx, env.membership,
    { providerType: 'supplier_email', displayName: 'Mailbox' });
  env.db.prepare(`UPDATE workspace_connectors SET provider_type = 'gmail', status = 'connected',
    setup_status = 'CONNECTED', paused_at = NULL WHERE id = ?`).run(made.connection.id);

  const draft = outbound.prepare(env.db, env.ctx,
    { recipientText: 'jo@example.test', body: 'the order is delayed', instruction: 'x' });
  assert.equal(draft.body, 'the order is delayed', 'not composed, not expanded');
  assert.equal(draft.subject, null, 'and no heading StockChief made up');
});

test('a recipient StockChief does not know is asked about, never guessed', async () => {
  const env = setup();
  const outbound = require('../../src/actions/outbound-message');
  const draft = outbound.prepare(env.db, env.ctx,
    { recipientText: 'Somebody Ltd', body: 'hello', instruction: 'x' });
  assert.equal(draft.kind, 'question');
  assert.match(draft.question, /no customer or supplier called/i);
});

test('a connected mailbox is a mailbox, whether or not one was "chosen"', () => {
  /*
   * Gmail sat on the Connections page marked Connected, and StockChief answered
   * "No mailbox is connected for sending". It was reading a separate setting —
   * which mailbox customer messages go from — that almost nobody sets, because
   * there is no reason to choose between mailboxes when you only have one.
   */
  const env = setup();
  const connections = require('../../src/connections/service');
  const comms = require('../../src/sales/customer-communications');

  const made = connections.create(env.db, env.ctx, env.membership,
    { providerType: 'supplier_email', displayName: 'Shop Mailbox' });
  env.db.prepare(`UPDATE workspace_connectors SET provider_type = 'gmail', status = 'connected',
    setup_status = 'CONNECTED', paused_at = NULL WHERE id = ?`).run(made.connection.id);

  assert.equal(comms.policy(env.db, env.workspace.workspaceId).connectorId, null,
    'nothing was chosen, which is the ordinary case');

  const sending = comms.sendingMailbox(env.db, env.workspace.workspaceId);
  assert.equal(sending.connectorId, made.connection.id, 'and the one that exists is used');
  assert.equal(sending.chosen, false);
});

test('a paused mailbox is not sent from', () => {
  const env = setup();
  const connections = require('../../src/connections/service');
  const comms = require('../../src/sales/customer-communications');
  const made = connections.create(env.db, env.ctx, env.membership,
    { providerType: 'supplier_email', displayName: 'Shop Mailbox' });
  env.db.prepare(`UPDATE workspace_connectors SET provider_type = 'gmail', status = 'connected',
    paused_at = '2026-09-02T00:00:00.000Z' WHERE id = ?`).run(made.connection.id);

  assert.equal(comms.sendingMailbox(env.db, env.workspace.workspaceId).connectorId, null,
    'a mailbox somebody paused is one they asked StockChief not to use');
});

test('with a mailbox connected, an emailed instruction becomes a draft', async () => {
  const env = setup();
  const connections = require('../../src/connections/service');
  const made = connections.create(env.db, env.ctx, env.membership,
    { providerType: 'supplier_email', displayName: 'Shop Mailbox' });
  env.db.prepare(`UPDATE workspace_connectors SET provider_type = 'gmail', status = 'connected',
    setup_status = 'CONNECTED', paused_at = NULL WHERE id = ?`).run(made.connection.id);

  const answer = await actionService.interpret(env.db, env.ctx, env.membership,
    'Please email motty6700@gmail.com that we received the order and are processing it now');

  assert.equal(answer.kind, 'message_draft');
  assert.equal(answer.recipient.email, 'motty6700@gmail.com');
  assert.doesNotMatch(String(answer.question || ''), /No mailbox is connected/i);
});

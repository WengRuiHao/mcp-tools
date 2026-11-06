// workflow 語意驗證：id 唯一、引用存在、依賴無環、locked 不得 auto、children 鏈、when 語法。
import test from "node:test";
import assert from "node:assert/strict";
import { validateWorkflow, validateChildrenChain, parseWhen, evalWhen } from "../dist/workflow/validate.js";
import { buildAsanaTicketWorkflow } from "../dist/workflow/builtin/asana-ticket.js";

const base = () => buildAsanaTicketWorkflow();
const has = (errors, re) => errors.some((e) => re.test(e));

test("內建定義語意合法", () => {
  assert.deepEqual(validateWorkflow(base()), []);
});

test("重複 id 被偵測", () => {
  const d = base();
  d.roles.push({ ...d.roles[0] });
  d.gates.push({ ...d.gates[0] });
  d.artifacts.push({ ...d.artifacts[0] });
  const e = validateWorkflow(d);
  assert.ok(has(e, /role id 重複/) && has(e, /gate id 重複/) && has(e, /artifact id 重複/));
});

test("引用不存在的角色／產出物被偵測", () => {
  const d = base();
  d.roles[0] = { ...d.roles[0], dependsOn: ["ghost"], inputs: ["nope"] };
  d.gates[0] = { ...d.gates[0], after: "ghost2" };
  const e = validateWorkflow(d);
  assert.ok(has(e, /不存在的角色：ghost$/) && has(e, /不存在的產出物：nope/) && has(e, /after 引用不存在的角色：ghost2/));
});

test("依賴有環被偵測", () => {
  const d = base();
  d.roles[0] = { ...d.roles[0], dependsOn: ["tester"] };
  assert.ok(has(validateWorkflow(d), /依賴有環/));
});

test("locked 關卡設為 auto 被拒；非 content 關卡不可有 checks", () => {
  const d = base();
  d.gates = d.gates.map((g) => (g.id === "final-acceptance" ? { ...g, confirmMode: "auto" } : g));
  d.gates = d.gates.map((g) => (g.id === "verdict" ? { ...g, checks: [] } : g));
  const e = validateWorkflow(d);
  assert.ok(has(e, /locked，不得設為 auto/) && has(e, /不是 content 關卡/));
});

test("when 語法：只接受 key==value 與 &&", () => {
  assert.deepEqual(parseWhen("a==b && c==d"), [["a", "b"], ["c", "d"]]);
  for (const bad of ["a=b", "a==b || c==d", "a!=b", "", "a=="]) assert.equal(parseWhen(bad), null, bad);
  const d = base();
  d.roles[0] = { ...d.roles[0], when: "a!=b" };
  assert.ok(has(validateWorkflow(d), /when 語法不合法/));
});

test("evalWhen：全部條件成立才為真；未設定恆為真；語法錯丟錯", () => {
  assert.equal(evalWhen(undefined, {}), true);
  assert.equal(evalWhen("a==1 && b==2", { a: "1", b: "2" }), true);
  assert.equal(evalWhen("a==1 && b==2", { a: "1", b: "3" }), false);
  assert.equal(evalWhen("a==1", { a: null }), false);
  assert.throws(() => evalWhen("bad", {}));
});

test("children：feature 不可有 children；來源產出物須存在", () => {
  const d = { ...base(), children: { from: "nope", workflow: "x" } };
  const e = validateWorkflow(d);
  assert.ok(has(e, /不可有 children/) && has(e, /children\.from/));
});

test("children 鏈：system→module→feature 合法，跳級被拒，找不到被拒", () => {
  const feature = base();
  const mod = { ...base(), id: "mod", granularity: "module", children: { from: "analysis", workflow: feature.id } };
  const sys = { ...base(), id: "sys", granularity: "system", children: { from: "analysis", workflow: "mod" } };
  const reg = new Map([[feature.id, feature], ["mod", mod], ["sys", sys]]);
  const lookup = (id) => reg.get(id);
  assert.deepEqual(validateChildrenChain(sys, lookup), []);
  const skip = { ...sys, children: { from: "analysis", workflow: feature.id } };
  assert.ok(has(validateChildrenChain(skip, lookup), /必須是 module/));
  assert.ok(has(validateChildrenChain({ ...sys, children: { from: "analysis", workflow: "zzz" } }, lookup), /找不到/));
  assert.deepEqual(validateChildrenChain(feature, lookup), []);
});

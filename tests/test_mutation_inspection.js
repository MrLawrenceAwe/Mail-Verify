import test from "node:test";
import assert from "node:assert/strict";
import { createMutationInspection } from "../extension/inline/mutation-inspection.js";

function inspectMutations(records, host) {
  const inspector = createMutationInspection((text) => /email/i.test(text));
  return inspector.recordsRequireRediscovery(records, host, (record, inspectAttributeSubtree) => {
    if (record.type === "attributes")
      return inspectAttributeSubtree &&
        inspector.subtreeRequiresRediscovery(record.target, "input", true);
    if (record.type === "characterData")
      return inspector.textRequiresRediscovery(record.target.textContent || "") ||
        inspector.textRequiresRediscovery(record.oldValue || "");
    for (const nodes of [record.addedNodes, record.removedNodes])
      for (const node of nodes)
        if (inspector.subtreeRequiresRediscovery(node, "input", true)) return true;
    return false;
  });
}

test("attribute decisions retain every record while subtree inspection is deduplicated", () => {
  const target = {};
  const records = ["class", "style", "class", "id"].map((attributeName) => ({
    type: "attributes", attributeName, target,
  }));
  const decisions = [];
  const inspector = createMutationInspection(() => false);
  assert.equal(inspector.recordsRequireRediscovery(records, null, (record, inspectSubtree) => {
    decisions.push([record.attributeName, inspectSubtree]);
    return record.attributeName === "id";
  }), true);
  assert.deepEqual(decisions, [
    ["class", true], ["style", false], ["class", false], ["id", false],
  ]);
});

test("suggestion hosts and their descendants are excluded before inspection", () => {
  const child = {};
  const host = { contains: (target) => target === child };
  const inspector = createMutationInspection(() => false);
  assert.equal(inspector.recordsRequireRediscovery([
    { type: "attributes", target: host },
    { type: "characterData", target: child },
  ], host, () => assert.fail("suggestion content must not be inspected")), false);
});

test("current and previous character data consume the same text budget", () => {
  const records = Array.from({ length: 100 }, () => ({
    type: "characterData",
    target: { nodeType: 3, textContent: "x".repeat(1000) },
    oldValue: "y".repeat(1000),
  }));
  const inspector = createMutationInspection(() => false);
  let inspected = 0;
  assert.equal(inspector.recordsRequireRediscovery(records, null, (record) => {
    inspected++;
    return inspector.textRequiresRediscovery(record.target.textContent) ||
      inspector.textRequiresRediscovery(record.oldValue);
  }), true);
  assert.equal(inspected, 6);
});

test("large added and removed subtrees queue a scan without aggregate text or descendant queries", () => {
  const subtree = {
    nodeType: 1,
    matches: () => false,
    get textContent() {
      assert.fail("must not aggregate subtree text");
    },
    querySelector() {
      assert.fail("must not query an unbounded subtree");
    },
  };
  subtree.firstChild = {
    nodeType: 3,
    textContent: "x".repeat(2_000_000),
    parentNode: subtree,
  };
  for (const changedNodes of ["addedNodes", "removedNodes"]) {
    const record = {
      type: "childList",
      target: { nodeType: 1 },
      addedNodes: [],
      removedNodes: [],
    };
    record[changedNodes] = [subtree];
    assert.equal(inspectMutations([record]), true);
  }
});

test("attribute text inspection shares the text budget and deduplicates subtrees", () => {
  let reads = 0;
  const records = Array.from({ length: 20 }, () => {
    const target = { nodeType: 1, matches: () => false };
    target.firstChild = {
      nodeType: 3,
      parentNode: target,
      get textContent() {
        reads++;
        return "x".repeat(1000);
      },
    };
    return { type: "attributes", target };
  });
  assert.equal(
    inspectMutations([records[0], records[0]]),
    false,
  );
  assert.equal(reads, 1);
  reads = 0;
  assert.equal(inspectMutations(records), true);
  assert.equal(
    reads,
    11,
    "text inspection stops when the batch budget is exhausted",
  );
});

test("mutation node and text budgets apply across the whole batch", () => {
  let inspected = 0;
  const records = Array.from({ length: 2000 }, () => ({
    type: "childList",
    target: { nodeType: 1 },
    removedNodes: [],
    addedNodes: [
      {
        nodeType: 1,
        matches: () => false,
        get firstChild() {
          inspected++;
          return null;
        },
      },
    ],
  }));
  assert.equal(inspectMutations(records), true);
  assert.equal(inspected, 500);

  let textReads = 0;
  const textRecords = Array.from({ length: 100 }, () => ({
    type: "characterData",
    target: {
      nodeType: 3,
      get textContent() {
        textReads++;
        return "x".repeat(1000);
      },
    },
    oldValue: "",
  }));
  assert.equal(
    inspectMutations(textRecords),
    true,
  );
  assert.equal(textReads, 11);
});

test("short character-data records share the node budget with subtree traversal", () => {
  let reads = 0;
  const records = Array.from({ length: 1000 }, () => ({
    type: "characterData",
    target: {
      nodeType: 3,
      get textContent() {
        reads++;
        return "x";
      },
    },
    oldValue: "y",
  }));
  const subtree = {
    type: "childList",
    target: { nodeType: 1 },
    addedNodes: [{ nodeType: 1, matches: () => false }],
    removedNodes: [],
  };
  assert.equal(inspectMutations(records.slice(0, 500)), false);
  assert.equal(reads, 500);
  reads = 0;
  assert.equal(inspectMutations([subtree, ...records]), true);
  assert.equal(reads, 499);
});

test("repeated attribute targets traverse their subtree once per batch", () => {
  let inspections = 0;
  const target = {
    nodeType: 1,
    matches() {
      inspections++;
      return false;
    },
    querySelector() {
      assert.fail("must not query unrestricted descendants");
    },
  };
  const records = Array.from({ length: 1000 }, () => ({
    type: "attributes",
    target,
  }));
  assert.equal(inspectMutations(records), false);
  assert.equal(inspections, 1);
});

test("attribute inspection shares the batch node budget without descendant queries", () => {
  let inspected = 0;
  const records = Array.from({ length: 2000 }, () => ({
    type: "attributes",
    target: {
      nodeType: 1,
      matches: () => false,
      get firstChild() {
        inspected++;
        return null;
      },
      querySelector() {
        assert.fail("must not query unrestricted descendants");
      },
    },
  }));
  assert.equal(inspectMutations(records), true);
  assert.equal(inspected, 500);
});

test("one large attribute subtree exhausts the node budget and queues discovery", () => {
  let inspected = 0;
  const root = {
    nodeType: 1,
    matches: () => false,
    querySelector() {
      assert.fail("must not query unrestricted descendants");
    },
  };
  let node = root;
  for (let index = 0; index < 2000; index++) {
    const child = {
      nodeType: 1,
      matches: () => {
        inspected++;
        return false;
      },
      parentNode: node,
    };
    node.firstChild = child;
    node = child;
  }
  assert.equal(
    inspectMutations([{ type: "attributes", target: root }]),
    true,
  );
  assert.equal(inspected, 499);
});

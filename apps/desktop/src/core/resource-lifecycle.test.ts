import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { LazyResource } from "./resource-lifecycle.js";

test("lazy resources share one instance and stop after their final lease", async () => {
  let starts = 0;
  let stops = 0;
  const resource = new LazyResource(
    {
      start: () => ({ generation: ++starts }),
      stop: () => {
        stops += 1;
      },
    },
    5,
  );
  assert.equal(resource.state, "stopped");
  const first = await resource.acquire();
  const second = await resource.acquire();
  assert.equal(first.value, second.value);
  assert.equal(starts, 1);
  first.release();
  await delay(10);
  assert.equal(stops, 0);
  second.release();
  await delay(15);
  assert.equal(stops, 1);
  assert.equal(resource.state, "stopped");
});

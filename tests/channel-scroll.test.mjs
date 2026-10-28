import assert from "node:assert/strict";
import test from "node:test";
import { channelFollowOutput, channelIsAtBottom, nextChannelPinnedState } from "../src/domain/channel-scroll.js";

test("follow output uses preserved reader intent rather than a transient bottom report", () => {
  assert.equal(channelFollowOutput(true), "auto");
  assert.equal(channelFollowOutput(false), false);
});

test("measured scroll position overrides a stale at-bottom report", () => {
  assert.equal(channelIsAtBottom({ scrollHeight: 2000, scrollTop: 1200, clientHeight: 700 }, 48, true), false);
  assert.equal(channelIsAtBottom({ scrollHeight: 2000, scrollTop: 1252, clientHeight: 700 }, 48, false), true);
});

test("new activity and row resizing preserve follow mode while the reader was at the bottom", () => {
  assert.equal(nextChannelPinnedState(true, false, false), true);
});

test("a real user scroll away from the bottom pauses follow mode", () => {
  assert.equal(nextChannelPinnedState(true, false, true), false);
});

test("a user scroll wins over a stale at-bottom report", () => {
  assert.equal(nextChannelPinnedState(true, true, true), false);
});

test("reaching the latest activity resumes follow mode", () => {
  assert.equal(nextChannelPinnedState(false, true, false), true);
});

test("layout changes do not force a reader who scrolled up back to the bottom", () => {
  assert.equal(nextChannelPinnedState(false, false, false), false);
});

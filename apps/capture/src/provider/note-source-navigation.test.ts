import { afterEach, expect, it, vi } from "vitest";
import { scrollNoteSourceMatch } from "./note-source-navigation";

afterEach(() => { vi.unstubAllGlobals(); });
function region(height: number, scrollHeight: number, overflowY: string, top = 0) {
  return { clientHeight: height, scrollHeight, scrollTop: 0, overflowY, parentElement: null as unknown,
    getBoundingClientRect: () => ({ top, height }), closest: vi.fn(), scrollIntoView: vi.fn() };
}
const element = (value: unknown): HTMLElement => value as HTMLElement;

it("reveals a late mobile row in page flow instead of writing scrollTop on its automatic-height transcript", () => {
  const pane = region(6400, 6400, "visible"), evidence = region(6600, 6600, "visible");
  pane.parentElement = evidence; pane.closest.mockReturnValue(evidence);
  let pageY = 0;
  const row = { getBoundingClientRect: () => ({ top: 5800 - pageY, height: 100 }),
    scrollIntoView: vi.fn((options: ScrollIntoViewOptions) => { if (options.block === "center") pageY = 5800 - 350; }) };
  vi.stubGlobal("window", { getComputedStyle: (node: typeof pane) => ({ overflowY: node.overflowY }) });
  scrollNoteSourceMatch(element(pane), element(row));
  expect(row.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "center", behavior: "auto" });
  expect(row.getBoundingClientRect().top).toBe(350); expect(pane.scrollTop).toBe(0); expect(evidence.scrollTop).toBe(0);
});

it("uses the real bounded desktop evidence ancestor when the inner transcript cannot scroll", () => {
  const pane = region(6400, 6400, "visible", 200), evidence = region(600, 6600, "auto", 100);
  pane.parentElement = evidence; pane.closest.mockReturnValue(evidence);
  const row = region(100, 100, "visible", 5800);
  vi.stubGlobal("window", { getComputedStyle: (node: typeof pane) => ({ overflowY: node.overflowY }) });
  scrollNoteSourceMatch(element(pane), element(row));
  expect(evidence.scrollTop).toBe(5450); expect(pane.scrollTop).toBe(0); expect(row.scrollIntoView).not.toHaveBeenCalled();
});

it("does not mistake overflow-visible height constraints for a scrollable transcript", () => {
  const pane = region(400, 6400, "visible"), evidence = region(6600, 6600, "visible");
  pane.parentElement = evidence; pane.closest.mockReturnValue(evidence);
  const row = region(100, 100, "visible", 5800);
  vi.stubGlobal("window", { getComputedStyle: (node: typeof pane) => ({ overflowY: node.overflowY }) });
  scrollNoteSourceMatch(element(pane), element(row));
  expect(pane.scrollTop).toBe(0); expect(row.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "center", behavior: "auto" });
});

it("uses a scrollable inner pane without scrolling any outer visit or the document", () => {
  const pane = region(600, 6400, "scroll", 100), evidence = region(800, 6600, "auto", 0);
  pane.parentElement = evidence; pane.closest.mockReturnValue(evidence);
  const row = region(100, 100, "visible", 5800);
  vi.stubGlobal("window", { getComputedStyle: (node: typeof pane) => ({ overflowY: node.overflowY }) });
  scrollNoteSourceMatch(element(pane), element(row));
  expect(pane.scrollTop).toBe(5450); expect(evidence.scrollTop).toBe(0); expect(row.scrollIntoView).not.toHaveBeenCalled();
});

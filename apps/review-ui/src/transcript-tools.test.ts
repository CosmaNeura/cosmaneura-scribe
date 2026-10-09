import { afterEach, expect, it, vi } from "vitest";
import { bindTranscriptTools } from "./transcript-tools";

afterEach(() => vi.unstubAllGlobals());

it("searches and navigates matching passages without changing source text, IDs or speaker uncertainty", () => {
  // Minimal event surface: actual search/navigation handlers execute without a browser.
  class ElementSurface extends EventTarget {
    closest(selector: string): ElementSurface | null {
      return selector === "[data-transcript-surface]" ? surface : null;
    }
  }
  class Row extends ElementSurface {
    hidden = false;
    readonly dataset: { transcriptSegment: string; searchCurrent?: string };
    readonly focus = vi.fn();
    readonly scrollIntoView = vi.fn();
    constructor(readonly content: string, id: string) { super(); this.dataset = { transcriptSegment: id }; }
    querySelectorAll(): { textContent: string }[] { return [{ textContent: this.content }, { textContent: "Speaker 1 · not identified" }]; }
    removeAttribute(): void { delete this.dataset.searchCurrent; }
  }
  class SearchInput extends ElementSurface {
    value = "";
    readonly focus = vi.fn();
    matches(selector: string): boolean { return selector === "[data-transcript-search]"; }
  }
  class Button extends ElementSurface {
    disabled = false;
    readonly dataset: { transcriptMatch: string };
    constructor(direction: string, readonly clear = false) { super(); this.dataset = { transcriptMatch: direction }; }
    override closest(selector: string): ElementSurface | null {
      return selector === "[data-transcript-match], [data-transcript-clear]" ? this : super.closest(selector);
    }
    hasAttribute(): boolean { return this.clear; }
  }
  const rows = [new Row("Síntoma ficticio primero.", "source-a"), new Row("Síntoma ficticio segundo.", "source-b"),
    new Row("No other invented concern.", "source-c")];
  const input = new SearchInput(), next = new Button("next"), previous = new Button("previous"), clear = new Button("", true);
  const status = { textContent: "" };
  class TranscriptSurface extends ElementSurface {
    querySelector(selector: string): SearchInput | typeof status | null {
      return selector === "[data-transcript-search]" ? input : selector === "[data-transcript-search-status]" ? status : null;
    }
    querySelectorAll(selector: string): Row[] | Button[] {
      return selector === "[data-transcript-segment]" ? rows : [next, previous];
    }
  }
  const surface = new TranscriptSurface();
  const root = Object.assign(new EventTarget(), { contains: (element: unknown) => element instanceof ElementSurface });
  vi.stubGlobal("Element", ElementSurface); vi.stubGlobal("HTMLInputElement", SearchInput);
  const original = rows.map(row => ({ id: row.dataset.transcriptSegment, content: row.content, text: row.querySelectorAll() }));
  const dispose = bindTranscriptTools(root as unknown as HTMLElement);
  const dispatch = (type: string, target: ElementSurface): void => {
    const event = new Event(type); Object.defineProperty(event, "target", { value: target }); root.dispatchEvent(event);
  };
  try {
    input.value = "SINTOMA"; dispatch("input", input);
    expect(status.textContent).toBe("2 matching passages");
    expect(rows.map(row => row.hidden)).toEqual([false, false, true]);
    dispatch("click", next); dispatch("click", next);
    expect(rows[1]!.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(rows[1]!.dataset.searchCurrent).toBe("true");
    dispatch("click", previous);
    expect(rows[0]!.dataset.searchCurrent).toBe("true");
    expect(rows[1]!.dataset.searchCurrent).toBeUndefined();
    input.value = "segundo"; dispatch("input", input);
    expect(status.textContent).toBe("1 matching passage");
    input.value = "absent"; dispatch("input", input);
    expect(status.textContent).toBe("0 matching passages");
    expect(next.disabled && previous.disabled).toBe(true);
    dispatch("click", clear);
    expect(input.value).toBe("");
    expect(status.textContent).toBe("3 transcript passages");
    expect(rows.every(row => !row.hidden)).toBe(true);
    expect(rows.map(row => ({ id: row.dataset.transcriptSegment, content: row.content, text: row.querySelectorAll() }))).toEqual(original);
  } finally { dispose(); }
});

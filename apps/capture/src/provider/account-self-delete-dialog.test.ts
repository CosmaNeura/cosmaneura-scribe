import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_SELF_DELETE_MESSAGES, type AccountSelfDeleteHost } from "./account-self-delete";
import { mountAccountSelfDeleteDialog } from "./account-self-delete-dialog";

type Listener = (event: Event) => void;

class Node {
  readonly children: Node[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Set<Listener>>();
  parent: Node | null = null;
  textContent = "";
  value = "";
  hidden = false;
  disabled = false;
  className = "";
  isConnected = true;
  tagName: string;
  ownerDocument: Doc;
  constructor(tagName: string, ownerDocument: Doc) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  set innerHTML(value: string) {
    this.children.length = 0;
    const voidTags = new Set(["input", "br", "hr", "img", "meta", "link"]);
    const tokens = value.match(/<[^>]+>|[^<]+/g) ?? [];
    const stack: Node[] = [this];
    for (const token of tokens) {
      if (token.startsWith("</")) {
        stack.pop();
        continue;
      }
      if (token.startsWith("<")) {
        const match = token.match(/^<([a-z0-9-]+)([^>]*)\/?>/i);
        if (!match) continue;
        const tag = match[1]!.toLowerCase();
        const node = this.ownerDocument.createElement(tag);
        for (const attr of match[2]!.match(/([a-z0-9-]+)(?:="([^"]*)")?/gi) ?? []) {
          const parts = attr.match(/([a-z0-9-]+)(?:="([^"]*)")?/i);
          if (!parts) continue;
          const name = parts[1]!;
          const raw = parts[2] ?? "";
          if (name === "hidden") node.hidden = true;
          else if (name === "disabled") node.disabled = true;
          else if (name === "class") node.className = raw;
          else if (name.startsWith("data-")) {
            node.dataset[name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = raw;
            node.setAttribute(name, raw);
          } else node.setAttribute(name, raw);
        }
        stack.at(-1)!.append(node);
        if (!voidTags.has(tag) && !token.endsWith("/>")) stack.push(node);
        continue;
      }
      stack.at(-1)!.textContent += token;
    }
  }
  get innerHTML() { return this.textContent; }
  append(...nodes: Node[]) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  querySelector(selector: string): Node | null {
    const walk = (node: Node): Node | null => {
      if (matches(node, selector)) return node;
      for (const child of node.children) {
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }
  addEventListener(type: string, listener: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() {}
  close() {}
  remove() {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
    this.isConnected = false;
  }
}

function matches(node: Node, selector: string): boolean {
  if (selector.startsWith("[") && selector.endsWith("]")) {
    const body = selector.slice(1, -1);
    if (body.startsWith("data-")) {
      const key = body.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      return Object.prototype.hasOwnProperty.call(node.dataset, key) || node.attributes.has(body);
    }
    return node.attributes.has(body);
  }
  return false;
}

class Doc {
  activeElement: Node | null = null;
  body = new Node("body", this);
  createElement(tag: string) { return new Node(tag, this); }
}

afterEach(() => { vi.unstubAllGlobals(); });

function host(practiceLeftOwnerless: boolean): AccountSelfDeleteHost {
  return {
    client: {
      deleteAccount: async () => ({
        outcome: "deleted", status: "deleted", practiceLeftOwnerless, clerkIdentityRemoved: true,
      }),
    },
    sameAccountSession: () => true,
    closeWorkspace: async () => undefined,
    purgeLocalClinicalData: async () => undefined,
    clearLocalCredentials: async () => undefined,
  };
}

describe("account self-delete dialog copy", () => {
  it("shows confirm body (b), hides old permanently-deletes string, and gates ownerless notice (a)", async () => {
    const document = new Doc();
    vi.stubGlobal("document", document);
    vi.stubGlobal("HTMLElement", Node);
    const parent = document.createElement("div");
    document.body.append(parent);
    const dispose = mountAccountSelfDeleteDialog(parent as unknown as HTMLElement, host(false));
    const dialog = parent.children[0]!;
    expect(dialog.querySelector("[data-confirm-body]")?.textContent)
      .toBe(ACCOUNT_SELF_DELETE_MESSAGES.confirmBody);
    expect(dialog.querySelector("[data-ownerless-notice]")?.textContent)
      .toBe(ACCOUNT_SELF_DELETE_MESSAGES.practiceLeftOwnerlessNotice);
    expect(dialog.querySelector("[data-ownerless-notice]")?.hidden).toBe(true);
    const markup = [
      dialog.querySelector("[data-confirm-body]")?.textContent,
      dialog.querySelector("[data-ownerless-notice]")?.textContent,
    ].join("\n");
    expect(markup).not.toMatch(/permanently deletes/);
    dispose();
  });

  it("reveals ownerless notice (a) only after practiceLeftOwnerless becomes true", async () => {
    const document = new Doc();
    vi.stubGlobal("document", document);
    vi.stubGlobal("HTMLElement", Node);
    const parent = document.createElement("div");
    document.body.append(parent);
    const dispose = mountAccountSelfDeleteDialog(parent as unknown as HTMLElement, host(true));
    const dialog = parent.children[0]!;
    const notice = dialog.querySelector("[data-ownerless-notice]")!;
    expect(notice.hidden).toBe(true);
    const input = dialog.querySelector("[data-confirmation]")!;
    input.value = "DELETE";
    for (const listener of input.listeners.get("input") ?? []) listener({} as Event);
    const submit = dialog.querySelector("[data-submit]")!;
    for (const listener of submit.listeners.get("click") ?? []) listener({} as Event);
    await vi.waitFor(() => expect(notice.hidden).toBe(false));
    expect(notice.textContent).toBe(ACCOUNT_SELF_DELETE_MESSAGES.practiceLeftOwnerlessNotice);
    dispose();
  });

  it("keeps ownerless notice (a) hidden when practiceLeftOwnerless is false", async () => {
    const document = new Doc();
    vi.stubGlobal("document", document);
    vi.stubGlobal("HTMLElement", Node);
    const parent = document.createElement("div");
    document.body.append(parent);
    const dispose = mountAccountSelfDeleteDialog(parent as unknown as HTMLElement, host(false));
    const dialog = parent.children[0]!;
    const notice = dialog.querySelector("[data-ownerless-notice]")!;
    const input = dialog.querySelector("[data-confirmation]")!;
    input.value = "DELETE";
    for (const listener of input.listeners.get("input") ?? []) listener({} as Event);
    const submit = dialog.querySelector("[data-submit]")!;
    for (const listener of submit.listeners.get("click") ?? []) listener({} as Event);
    await vi.waitFor(() => {
      expect(dialog.querySelector("[data-status]")?.textContent)
        .toBe(ACCOUNT_SELF_DELETE_MESSAGES.deleted);
    });
    expect(notice.hidden).toBe(true);
    dispose();
  });
});

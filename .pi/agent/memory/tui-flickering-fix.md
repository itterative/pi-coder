---
name: tui-flickering-fix
description: Layout invariants that prevent permission-dialog flickering when content exceeds terminal height.
category: architecture
---

# Permission dialog layout

`src/tui/select-with-message.ts` keeps the title short and puts long command text in a capped, scrollable content area. The content area renders numbered, manually wrapped lines; selection items and help text remain below it and visible. PageUp/PageDown update the content scroll offset.

Wrapping uses `wrapTextWithAnsi` for command content and `wrapPreservingSpaces` through `InlineEditor` for in-progress feedback, so trailing spaces remain visible while typing. The edit area is capped at three visual lines and uses a cursor-safe window; the cursor is never placed on a truncated first/last line.

`InlineEditor` is shared by `select-with-message.ts` and `ask-user.ts`. Keep layout and editing fixes in the shared editor where possible, and preserve the render-after-input behavior used by `test/helpers.ts` because vertical cursor movement depends on render-computed visual-line state.

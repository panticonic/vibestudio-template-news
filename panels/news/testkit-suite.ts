import { contextId } from "@workspace/runtime";
import {
  suite,
  withPanel,
  waitForText,
  evalInPanel,
  expect,
  setViewport,
  audit,
} from "@workspace/testkit";

/** The caller supplies a public HTTP RSS fixture with a non-feed sibling /invalid
 * response and these two stories. All installation, ingestion and reader actions are real. */
export function newsReaderJourney(feedUrl: string) {
  const first = "A useful first story";
  const second = "Another story worth keeping";
  return suite("news-reader-journey", {
    timeoutMs: 180_000,
    usesPanelAutomation: true,
  }).test(
    "recovers source setup, saves a story and restores it after reload",
    async (t) => {
      await withPanel(
        "panels/news",
        async (handle) => {
          await waitForText(handle, "Add source", { timeoutMs: 120_000 });
          const session = await handle.cdp.session();
          const page = session.page;
          const source = page.getByRole("textbox", {
            name: "Site or feed URL",
          });
          await source.fill(new URL("invalid", feedUrl).href);
          await page
            .getByRole("button", { name: "Add source", exact: true })
            .click();
          await waitForText(handle, "not a feed");
          expect(
            await source.inputValue(),
            "rejected source remains editable",
          ).toBe(new URL("invalid", feedUrl).href);
          await source.fill(feedUrl);
          await page
            .getByRole("button", { name: "Add source", exact: true })
            .click();
          // Ingestion includes a real model-backed triage on a cold installed worker.
          await waitForText(handle, first, { timeoutMs: 120_000 });
          await waitForText(handle, second);
          await page
            .getByRole("button", { name: `Save ${second}`, exact: true })
            .click();
          await page
            .getByRole("button", { name: `Remove ${second}`, exact: true })
            .waitFor();
          await page.getByRole("radio", { name: "Saved", exact: true }).click();
          await waitForText(handle, second);
          expect(
            await evalInPanel<boolean>(
              handle,
              `!!document.querySelector('.news-story-actions [aria-label="Remove ${second}"]')`,
            ),
            "saved story is actionable",
          ).toBe(true);
          const identity = await handle.stateArgs.get<Record<string, string>>();
          await handle.reload();
          await waitForText(handle, first);
          // The stable session page binds the reloaded renderer itself.
          await page
            .getByRole("radio", { name: "Saved", exact: true })
            .click();
          await waitForText(handle, second);
          const restoredIdentity =
            await handle.stateArgs.get<Record<string, string>>();
          expect(
            restoredIdentity["channelName"],
            "same reader channel after reload",
          ).toBe(identity["channelName"]);
          expect(
            restoredIdentity["agentKey"],
            "same reader agent after reload",
          ).toBe(identity["agentKey"]);
          await page
            .getByRole("button", { name: `Remove ${second}`, exact: true })
            .click();
          await waitForText(handle, "Nothing saved yet");
          for (const width of [320, 390, 1280]) {
            await setViewport(handle, { width, height: 844 });
            expect(
              (await audit(handle)).horizontalOverflow,
              `reader layout at ${width}`,
            ).toBe(false);
          }
          await page
            .getByRole("textbox", { name: "Search your news" })
            .fill(
              "An intentionally long literal search query that does not match either fixed story",
            );
          await waitForText(handle, "No matches");
          t.log(
            "The source failure remained recoverable; accepted Saved state survived reload.",
          );
        },
        { contextId, focus: false },
      );
    },
  );
}

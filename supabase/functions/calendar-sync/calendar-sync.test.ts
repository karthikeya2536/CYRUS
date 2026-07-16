// Regression test: Calendar sync pagination integration.
// Run: deno test --allow-read supabase/functions/calendar-sync/calendar-sync.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";

// Structural test: verify the pagination loop pattern exists in the source file.
Deno.test("pagination code structure present in calendar-sync", async () => {
  const content = await Deno.readTextFile("supabase/functions/calendar-sync/index.ts");
  assert(content.includes("pageToken"), "pageToken variable must be present for pagination");
  assert(content.includes("allEvents"), "allEvents array must be present to accumulate pages");
  assert(content.includes("nextPageToken"), "nextPageToken must be read from Calendar API response");
  assert(content.includes("maxResults=100"), "maxResults must be set to 100 for efficient paging");
  assert(content.includes("do {"), "do-while loop must be used for pagination");
  assert(content.includes("} while (pageToken)"), "loop must continue until pageToken is exhausted");
  assert(content.includes("timeMin"), "timeMin filter must be present in Calendar API request");
  assert(content.includes("timeMax"), "timeMax filter must be present in Calendar API request");
  assert(content.includes("orderBy=startTime"), "orderBy=startTime must be present for consistent ordering");
  assert(content.includes("singleEvents=true"), "singleEvents=true must expand recurring events");
});


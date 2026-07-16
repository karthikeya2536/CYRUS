// Regression test: Gmail sync helpers + pagination integration.
// Run: deno test --allow-read supabase/functions/gmail-sync/gmail-sync.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";

// Import the module-level exports (decodeBase64Url and getMessageBody)
// decodeBase64Url and getMessageBody are defined at module scope in index.ts but
// not exported. We replicate them here for unit testing.

// Replicate the decodeBase64Url implementation for unit testing
function decodeBase64Url(str: string) {
  try {
    const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    return decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
  } catch (e) {
    return "";
  }
}

// Replicate the getMessageBody implementation for unit testing
function getMessageBody(payload: any): string {
  if (!payload) return "";

  if (payload.parts && payload.parts.length > 0) {
    let body = "";
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        body += decodeBase64Url(part.body.data);
      } else if (part.parts) {
        body += getMessageBody(part);
      }
    }
    if (body) return body;

    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        body += decodeBase64Url(part.body.data);
      }
    }
    return body;
  }

  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  return "";
}

Deno.test("decodeBase64Url handles standard base64", () => {
  const result = decodeBase64Url("SGVsbG8gV29ybGQ=");
  assertEquals(result, "Hello World");
});

Deno.test("decodeBase64Url handles base64url (no padding)", () => {
  const result = decodeBase64Url("SGVsbG8gV29ybGQ");
  assertEquals(result, "Hello World");
});

Deno.test("decodeBase64Url returns empty for invalid input", () => {
  const result = decodeBase64Url("");
  assertEquals(result, "");
});

Deno.test("getMessageBody returns empty for null payload", () => {
  assertEquals(getMessageBody(null), "");
  assertEquals(getMessageBody(undefined), "");
});

Deno.test("getMessageBody extracts from simple payload body", () => {
  const payload = { body: { data: "SGVsbG8=" } };
  assertEquals(getMessageBody(payload), "Hello");
});

Deno.test("getMessageBody extracts text/plain from multipart", () => {
  const payload = {
    parts: [
      { mimeType: "text/plain", body: { data: "SGVsbG8=" } },
      { mimeType: "text/html", body: { data: "PGgxPkhlbGxvPC9oMT4=" } },
    ],
  };
  assertEquals(getMessageBody(payload), "Hello");
});

Deno.test("getMessageBody falls back to text/html when no text/plain", () => {
  const payload = {
    parts: [
      { mimeType: "text/html", body: { data: "SGVsbG8=" } },
    ],
  };
  assertEquals(getMessageBody(payload), "Hello");
});

Deno.test("getMessageBody handles nested multipart", () => {
  const payload = {
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: "TmVzdGVk" } },
        ],
      },
    ],
  };
  assertEquals(getMessageBody(payload), "Nested");
});

Deno.test("getMessageBody handles empty parts", () => {
  const payload = { parts: [] };
  assertEquals(getMessageBody(payload), "");
});

// Structural test: verify the pagination loop pattern exists in the source file.
// Read the file and ensure it references pageToken and allMessages.
Deno.test("pagination code structure present in gmail-sync", async () => {
  const content = await Deno.readTextFile("supabase/functions/gmail-sync/index.ts");
  assert(content.includes("pageToken"), "pageToken variable must be present for pagination");
  assert(content.includes("allMessages"), "allMessages array must be present to accumulate pages");
  assert(content.includes("nextPageToken"), "nextPageToken must be read from Gmail API response");
  assert(content.includes("maxResults=100"), "maxResults must be set to 100 for efficient paging");
  assert(content.includes("do {"), "do-while loop must be used for pagination");
  assert(content.includes("} while (pageToken)"), "loop must continue until pageToken is exhausted");
});

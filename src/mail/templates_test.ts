import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  escapeHtml,
  renderEmailChangeMail,
  renderEmailChangeNoticeMail,
  renderKoderMail,
  renderMessageMail,
  renderVerifyMail,
  setMailBaseUrl,
} from "./templates.ts";

const MESSAGE = {
  namn: "Elin",
  var: "Pendeltåget mot Uppsala",
  meddelande: "Du läste en bok med gul rygg.",
  kanal: "instagram" as const,
  kontakt: "elinsomlaser",
  antalIdag: 2,
  maxPerDag: 20,
  slugKort: "ojhej.se/s/K7M4…ABCD",
  hanteraUrl: "https://ojhej.se/hantera?t=abc123",
};

Deno.test("all three mails come with a subject and both body parts", () => {
  const mails = [
    renderMessageMail(MESSAGE),
    renderVerifyMail({ verifieraUrl: "https://ojhej.se/verifiera?t=x" }),
    renderKoderMail({ hanteraUrl: "https://ojhej.se/hantera?t=x", koder: KODER }),
  ];

  for (const mail of mails) {
    assert(mail.subject.length > 0, "every mail needs a subject");
    assert(mail.text.length > 0, "plain text is never optional, it keeps us out of spam");
    assert(mail.html.length > 0);
    assert(!mail.subject.includes("\n") && !mail.subject.includes("\r"));
  }
});

Deno.test("no placeholder survives into a rendered mail", () => {
  const mails = [
    renderMessageMail(MESSAGE),
    renderVerifyMail({ verifieraUrl: "https://ojhej.se/verifiera?t=x" }),
    renderKoderMail({ hanteraUrl: "https://ojhej.se/hantera?t=x", koder: KODER }),
  ];

  for (const mail of mails) {
    for (const part of [mail.subject, mail.text, mail.html]) {
      assert(!part.includes("{{"), `unrendered placeholder in: ${part.slice(0, 80)}`);
      assert(!part.includes("undefined"), `an undefined leaked into: ${part.slice(0, 80)}`);
    }
  }
});

Deno.test("the message reaches both parts", () => {
  const mail = renderMessageMail(MESSAGE);
  assertStringIncludes(mail.text, "Du läste en bok med gul rygg.");
  assertStringIncludes(mail.html, "Du läste en bok med gul rygg.");
  assertStringIncludes(mail.text, "Elin");
  assertStringIncludes(mail.html, "Elin");
});

/**
 * Four fields here are typed by a stranger into a public form and then rendered as HTML in
 * the owner's mail client. This is the highest-value injection surface in the product.
 */
Deno.test("visitor text cannot inject markup into the HTML part", () => {
  const mail = renderMessageMail({
    ...MESSAGE,
    namn: '<script>alert("x")</script>',
    var: '"><img src=x onerror=alert(1)>',
    meddelande: "<b>fet</b> & <i>kursiv</i>",
  });

  // The escaped text still *contains* the substring "onerror=", which is the point:
  // it is inert characters, not an attribute. So assert on structure, not on substrings.
  assert(!mail.html.includes("<script"), "no script element may survive");
  assert(!mail.html.includes("<b>fet</b>"), "even harmless markup is text, not markup");
  assertEquals(
    mail.html.match(/<img/g)?.length,
    1,
    "the only image is our own mark, nothing injected",
  );

  assertStringIncludes(mail.html, "&lt;script&gt;", "the tag arrives as visible text");
  assertStringIncludes(mail.html, "&lt;img src=x");
  assertStringIncludes(mail.html, "&amp;");
  assertStringIncludes(mail.html, "&quot;&gt;", "the quote that would end an attribute is escaped");
});

Deno.test("the plain text part carries the text as typed", () => {
  const mail = renderMessageMail({ ...MESSAGE, meddelande: "<b>fet</b> & sånt" });
  assertStringIncludes(mail.text, "<b>fet</b> & sånt");
});

Deno.test("visitor text cannot break out of an attribute", () => {
  const mail = renderMessageMail({
    ...MESSAGE,
    kanal: "instagram",
    kontakt: '" onmouseover="alert(1)',
  });

  assert(!mail.html.includes('onmouseover="'), "an attribute must not appear");
  assert(!mail.html.includes('href="" '), "no broken href either");
});

/* The contact detail becomes a tappable link, so the href is built from a validated
   value rather than pasted in. Anything that cannot be made into a safe URL stays text. */

Deno.test("a valid instagram handle becomes an instagram link", () => {
  const mail = renderMessageMail({ ...MESSAGE, kanal: "instagram", kontakt: "@elinsomlaser" });
  assertStringIncludes(mail.html, 'href="https://instagram.com/elinsomlaser"');
  assertStringIncludes(mail.text, "@elinsomlaser");
});

Deno.test("a valid address becomes a mailto link", () => {
  const mail = renderMessageMail({ ...MESSAGE, kanal: "mail", kontakt: "elin@exempel.se" });
  assertStringIncludes(mail.html, 'href="mailto:elin@exempel.se"');
});

Deno.test("a valid number becomes a tel link in international form", () => {
  const mail = renderMessageMail({ ...MESSAGE, kanal: "telefon", kontakt: "070-123 45 67" });
  // 0701234567 nationally, which is +46 701234567 once the trunk zero goes.
  assertStringIncludes(mail.html, 'href="tel:+46701234567"');
  assertStringIncludes(mail.text, "070-123 45 67", "the text part keeps it as they wrote it");
});

Deno.test("an unusable contact detail is shown as text, never as a link", () => {
  for (
    const [kanal, kontakt] of [
      ["instagram", "not a handle!!"],
      ["mail", "definitely not an address"],
      ["telefon", "ring mig"],
      ["mail", "javascript:alert(1)"],
    ] as const
  ) {
    const mail = renderMessageMail({ ...MESSAGE, kanal, kontakt });

    // Assert on the links, not on substrings: "javascript:alert(1)" rendered as visible
    // text is inert, and only its appearance in an href would matter.
    const hrefs = [...mail.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
    assertEquals(
      hrefs,
      [mail.html.includes(MESSAGE.hanteraUrl) ? MESSAGE.hanteraUrl : ""],
      `${kanal} ${kontakt} should leave only our own link in the mail`,
    );

    // Still shown, just as text, so the owner can decide what to make of it.
    assertStringIncludes(mail.html, escapeHtml(kontakt));
  }
});

Deno.test("the owner's own links are rendered as given", () => {
  const verify = renderVerifyMail({ verifieraUrl: "https://ojhej.se/verifiera?t=abc" });
  assertStringIncludes(verify.html, 'href="https://ojhej.se/verifiera?t=abc"');
  assertStringIncludes(verify.text, "https://ojhej.se/verifiera?t=abc");

  const koder = renderKoderMail({ hanteraUrl: "https://ojhej.se/hantera?t=xyz", koder: KODER });
  assertStringIncludes(koder.html, 'href="https://ojhej.se/hantera?t=xyz"');
  assertStringIncludes(koder.text, "https://ojhej.se/hantera?t=xyz");
});

Deno.test("the daily count is reported so the owner can see a flood coming", () => {
  const mail = renderMessageMail({ ...MESSAGE, antalIdag: 7, maxPerDag: 20 });
  assertStringIncludes(mail.text, "7");
  assertStringIncludes(mail.text, "20");
});

Deno.test("the subject never carries visitor text", () => {
  const mail = renderMessageMail({ ...MESSAGE, namn: "Bcc: spam@example.com" });
  assert(!mail.subject.includes("Bcc"), "a subject built from visitor text is a header risk");
});

/* ---------- changing the owner address ---------- */

/** Every mail carries the mark and nothing else pictorial, so this is the baseline to compare to. */
const MARK_IMAGES = 1;

Deno.test("the confirmation mail carries the link and says what has not happened yet", () => {
  const mail = renderEmailChangeMail({ bekraftaUrl: "https://ojhej.se/byt-epost?t=abc123" });

  assertEquals(mail.subject, "Bekräfta din nya mailadress");
  for (const part of [mail.text, mail.html]) {
    assertStringIncludes(part, "https://ojhej.se/byt-epost?t=abc123");
    assertStringIncludes(part, "gamla adressen", "it must be clear nothing has moved yet");
  }
});

/**
 * The notice to the old address is the only warning a real owner gets if someone who reached
 * their inbox tries to move the code. It must stay useful to a person being attacked, which
 * means no link to click and no action that helps whoever is doing it.
 */
Deno.test("the notice to the old address carries no link at all", () => {
  const mail = renderEmailChangeNoticeMail({ nyAdress: "angripare@exempel.se" });

  assertEquals(mail.subject, "Någon vill flytta din kod");
  assertStringIncludes(mail.text, "angripare@exempel.se", "the owner can see where it would go");
  assert(!mail.text.includes("http"), "a link here is a link an attacker chose the moment for");
  assertEquals(mail.html.match(/href=/g), null, "nor in the HTML part");
});

Deno.test("a hostile new address cannot inject markup into the notice", () => {
  const hostile = `"><img src=x onerror=alert(1)>@exempel.se`;
  const mail = renderEmailChangeNoticeMail({ nyAdress: hostile });

  // Counting elements rather than searching for text: the escaped form still *contains*
  // "onerror=", so a substring assertion here would pass for entirely the wrong reason.
  assertEquals(mail.html.match(/<img/g)?.length, MARK_IMAGES, "no image element was created");
  assertEquals(mail.html.match(/<script/g), null);
  assertStringIncludes(mail.html, "&lt;img", "it appears as text instead");
});

/**
 * Every mail opens with this image, and it is a real file at a real URL rather than inline SVG
 * or a data URI, because mail clients render neither reliably. It therefore has to exist in the
 * Storage Zone, and it did not: the reference shipped before the file did, which would have put
 * a broken image at the top of every verification mail ever sent.
 */
Deno.test("the mail mark points at a file that exists", async () => {
  const mail = renderVerifyMail({ verifieraUrl: "https://ojhej.se/verifiera?t=x" });
  const src = mail.html.match(/<img src="([^"]+)"/)![1]!;

  assertStringIncludes(src, "/mark.png");

  // The path is relative to the site root, and that is where the uploader puts it.
  const name = src.slice(src.lastIndexOf("/") + 1);
  const stat = await Deno.stat(`public/${name}`);
  assert(stat.isFile && stat.size > 0, `public/${name} is missing or empty`);
});

/* ---------- one mail for every code on an address ---------- */

const KODER = [
  { namn: "DEJTA", syfte: "hej" as const, status: "active" as const },
  { namn: "HITTAT?", syfte: "borttappat" as const, status: "active" as const },
  { namn: "SÄG HEJ", syfte: "fest" as const, status: "paused" as const },
];
const KODER_URL = "https://ojhej.se/hantera?t=abc123";

Deno.test("the koder mail carries one link, not one per code", () => {
  const mail = renderKoderMail({ hanteraUrl: KODER_URL, koder: KODER });

  assertEquals(mail.html.split(KODER_URL).length - 1, 2, "the button and the fallback, no more");
  assertEquals(mail.text.split(KODER_URL).length - 1, 1);
});

Deno.test("the koder mail names every code, so the reader can tell it is theirs", () => {
  const mail = renderKoderMail({ hanteraUrl: KODER_URL, koder: KODER });

  for (const part of [mail.html, mail.text]) {
    for (const kod of KODER) assertStringIncludes(part, kod.namn);
    assertStringIncludes(part, "Borttappat", "the purpose is named too");
    assertStringIncludes(part, "pausad", "and so is the state, which is why you opened it");
  }
});

/**
 * The list names printed labels and never addresses. A management mail is the one most likely to
 * be forwarded to somebody helping you, and a slug in it is a working address for a code that is
 * not theirs.
 */
Deno.test("the koder mail never carries a slug", () => {
  const mail = renderKoderMail({
    hanteraUrl: KODER_URL,
    koder: [{ namn: "DEJTA", syfte: "hej", status: "active" }],
  });

  for (const part of [mail.subject, mail.text, mail.html]) {
    assert(!part.includes("K7M4NPQR8TVWXYZ2ABCD"), "no slug may reach this mail");
    assert(!/\/s\/[A-Z0-9]{20}/.test(part), "and no scan address either");
  }
});

Deno.test("the koder mail counts what it is talking about", () => {
  const one = renderKoderMail({ hanteraUrl: KODER_URL, koder: [KODER[0]!] });
  assertEquals(one.subject, "Din kod");
  assertStringIncludes(one.text, "En länk till din kod.");

  const two = renderKoderMail({ hanteraUrl: KODER_URL, koder: KODER.slice(0, 2) });
  assertEquals(two.subject, "Dina koder");
  assertStringIncludes(two.text, "En länk till båda.");

  const three = renderKoderMail({ hanteraUrl: KODER_URL, koder: KODER });
  assertStringIncludes(three.text, "En länk till alla tre.");
});

Deno.test("a label an owner typed cannot become markup in their own mail", () => {
  const mail = renderKoderMail({
    hanteraUrl: KODER_URL,
    koder: [{ namn: `<img src=x onerror="alert(1)">`, syfte: "eget", status: "active" }],
  });

  // One image, and it is the mark in the header. The label contributed none.
  assertEquals(mail.html.match(/<img/g)?.length, 1);
  assertStringIncludes(mail.html, "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
});

Deno.test("the koder mail says how long the link lasts, and both parts agree", () => {
  const mail = renderKoderMail({ hanteraUrl: KODER_URL, koder: KODER });
  for (const part of [mail.text, mail.html]) {
    assertStringIncludes(part, "30 minuter");
  }
});

/**
 * The one artifact an owner keeps.
 *
 * Nothing is mailed after activation, so once the tab is closed the verification mail is the
 * only thing left in the inbox that came from us. It said how to activate and nothing about how
 * to come back, which left the route home in a browser tab somebody was about to close. Putting
 * it here costs no extra send and lands in the inbox that is already the key to the account.
 */
Deno.test("the verification mail says how to get back later", () => {
  setMailBaseUrl("https://ojhej.se");
  const mail = renderVerifyMail({ verifieraUrl: "https://ojhej.se/verifiera?t=x" });

  assertStringIncludes(mail.html, "https://ojhej.se/hantera");
  assertStringIncludes(mail.html, "Hantera koder");

  // The plain-text part is the one some clients show, and it carries the same route.
  assertStringIncludes(mail.text, "https://ojhej.se/hantera");
  assertStringIncludes(mail.text, "Hantera koder");
});

/** A preview deploy must not mail people a link into production. */
Deno.test("the way back follows the configured base url", () => {
  setMailBaseUrl("https://preview.ojhej.se");
  try {
    const mail = renderVerifyMail({ verifieraUrl: "https://preview.ojhej.se/verifiera?t=x" });
    assertStringIncludes(mail.html, "https://preview.ojhej.se/hantera");
    assertStringIncludes(mail.text, "https://preview.ojhej.se/hantera");
  } finally {
    setMailBaseUrl("https://ojhej.se");
  }
});

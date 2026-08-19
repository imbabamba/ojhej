/**
 * Client side of the two forms.
 *
 * The proof of work is solved as soon as the page loads rather than on submit, because it
 * takes on the order of a second and nobody should watch a spinner after pressing send.
 * By the time a visitor has typed a sentence it is long done.
 *
 * No framework, no dependencies, no third-party requests. This file and the stylesheet are
 * the whole client.
 */
(function () {
  "use strict";

  var form = document.getElementById("form");
  if (!form) return;

  var startedAt = Date.now();
  var solved = null;
  var tick = document.getElementById("altcha-tick");
  var label = document.getElementById("altcha-text");
  var submit = document.getElementById("skicka");
  var fel = document.getElementById("fel");

  function say(text, done) {
    if (label) label.textContent = text;
    if (tick) tick.textContent = done ? "✓" : "·";
  }

  function hex(buffer) {
    var out = "";
    var view = new Uint8Array(buffer);
    for (var i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, "0");
    return out;
  }

  async function sha256(text) {
    return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  }

  /**
   * Brute-force the number whose hash reproduces the challenge. Yields to the event loop
   * every few thousand attempts so the page stays responsive on a slow phone: a frozen
   * form is worse than a slow one.
   */
  async function solve(challenge) {
    for (var n = 0; n <= challenge.maxnumber; n++) {
      if (await sha256(challenge.salt + n) === challenge.challenge) return n;
      if (n % 5000 === 0) await new Promise(function (r) { setTimeout(r, 0); });
    }
    return null;
  }

  async function prepare() {
    try {
      say("Förbereder …", false);
      // A fresh challenge, from the network, every single time.
      //
      // 2026-08-14: /api/altcha went out carrying a thirty day max-age, so browsers stored one
      // challenge and went on replaying it. The proof of work is single use by design, so every
      // submission after the first was refused with "Det gick inte att skicka just nu", and the
      // only cure a visitor had was clearing their browser cache.
      //
      // Correcting the header on the server cannot reach an entry already sitting in somebody's
      // cache, and those entries live until mid September. A URL the cache has never seen is the
      // one thing that misses it in every browser; `no-store` says the same to those that listen.
      var fresh = "/api/altcha?f=" + Date.now() + "-" + Math.random().toString(36).slice(2);
      var challenge = await (await fetch(fresh, { cache: "no-store" })).json();
      var number = await solve(challenge);
      if (number === null) throw new Error("unsolved");

      solved = btoa(JSON.stringify({
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        number: number,
        salt: challenge.salt,
        signature: challenge.signature,
      }));

      say("Verifierad som människa", true);
      if (submit) submit.disabled = false;
    } catch (_) {
      // Fail visibly. Silently leaving the button disabled would look like a broken page.
      say("Kunde inte förbereda. Ladda om sidan.", false);
    }
  }

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    if (!solved) return;

    if (fel) fel.style.display = "none";
    if (submit) {
      submit.disabled = true;
      submit.textContent = "Skickar …";
    }

    var data = new FormData(form);
    var payload = { altcha: solved, startedAt: startedAt };
    data.forEach(function (value, key) { payload[key] = value; });

    try {
      var response = await fetch(form.dataset.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      var result = await response.json();

      if (response.ok) {
        window.location.href = form.dataset.next || "/";
        return;
      }

      if (fel) {
        fel.textContent = result.fel || "Det gick inte just nu.";
        fel.style.display = "block";
      }
    } catch (_) {
      if (fel) {
        fel.textContent = "Ingen kontakt med servern.";
        fel.style.display = "block";
      }
    }

    // A used challenge cannot be replayed, so a fresh one is needed before trying again.
    if (submit) submit.textContent = "Skicka";
    solved = null;
    prepare();
  });

  // Message form conveniences.
  var textarea = document.getElementById("meddelande");
  var count = document.getElementById("count");
  if (textarea && count) {
    textarea.addEventListener("input", function () {
      count.textContent = textarea.value.length + " / 600";
    });
  }

  var kontakt = document.getElementById("kontakt");
  var placeholders = { mail: "du@exempel.se", instagram: "@ditthandtag", telefon: "07× ××× ×× ××" };
  Array.prototype.forEach.call(document.getElementsByName("kanal"), function (radio) {
    radio.addEventListener("change", function (event) {
      if (!kontakt) return;
      kontakt.placeholder = placeholders[event.target.value];
      kontakt.value = "";
      kontakt.type = event.target.value === "telefon" ? "tel" : "text";
    });
  });

  var open = document.getElementById("open");
  var panel = document.getElementById("panel");
  var cta = document.getElementById("cta");
  if (open && panel) {
    open.addEventListener("click", function () {
      panel.classList.add("open");
      if (cta) cta.style.display = "none";
      setTimeout(function () {
        var first = document.getElementById("namn") || document.getElementById("epost");
        if (first) first.focus({ preventScroll: true });
        if (first) first.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 380);
    });
  }

  prepare();
})();

/** Copy buttons, e.g. the address on /klar. Lives outside the form guard above. */
(function () {
  "use strict";
  Array.prototype.forEach.call(document.querySelectorAll("[data-copy]"), function (button) {
    button.addEventListener("click", function () {
      var target = document.querySelector(button.getAttribute("data-copy"));
      if (!target) return;
      var text = target.textContent.trim();
      var done = function () { button.textContent = "Kopierad"; };
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(done, function () { done(); });
      } else {
        done();
      }
    });
  });
})();

/**
 * The print designer, on /klar.
 *
 * It used to be a page of its own at /tryck, reached by a link among other links, and nobody
 * could tell that was where the design lived. Now the controls sit directly under the preview
 * on the page you land on after verifying, because that is the moment you want them.
 *
 * Two controls, and that is deliberate. There were three shapes and a colour picker; a QR code
 * is a machine-readable thing first and every one of those settings traded scan reliability for
 * decoration. What remains is the text, and whether the code needs a light panel behind it.
 *
 * Every control rewrites the same URL, and the preview and the downloads both point at it, so
 * what is on screen is byte for byte what a print shop receives.
 */
(function () {
  "use strict";

  var preview = document.getElementById("preview");
  var designer = document.getElementById("designer");
  if (!preview || !designer) return;

  var slug = window.OJHEJ_KOD;
  // Read off the field rather than assumed: the label comes from the record, so a code that was
  // designed as HITTAT? must not spend its first paint claiming to say DEJTA.
  var labelField = document.getElementById("text");
  var state = { text: labelField ? labelField.value : "", platta: "nej" };

  function url(sizeMm, download, format) {
    var q = "?mm=" + sizeMm +
      "&platta=" + encodeURIComponent(state.platta) +
      "&text=" + encodeURIComponent(state.text);
    // The 60 mm chest print carries no centre mark: it needs the error correction more.
    if (sizeMm < 100) q += "&marke=nej";
    return "/api/qr/" + slug + "." + (format || "svg") + q + (download ? "&ladda" : "");
  }

  function row(name, meta, href, filename, format) {
    // The filename lives in the attribute as well as the response header, so saving works
    // even where a browser ignores one of them.
    return '<a class="dl" href="' + href + '" download="' + filename + '">' +
      '<span><span class="dl-name">' + name + "</span><br>" +
      '<span class="dl-meta">' + meta + "</span></span>" +
      '<span class="dl-fmt">' + (format || "svg").toUpperCase() + "</span></a>";
  }

  // The preview is an origin request: an isolate invocation, a storage read and a render. The
  // rest of `render` is local DOM work and stays immediate, so only this one is held back.
  //
  // Typing a 14-character label fired 14 of them in a burst, and the label never changes the
  // code's matrix, only the text band above it. A trailing wait means one request for a word.
  var previewTimer = null;
  function drawPreview() {
    var next = url(180, false);
    // Also guards the double fetch on load: the server renders this same picture into `src`
    // without `platta`, so assigning the computed URL unconditionally pulled it a second time.
    if (preview.getAttribute("src") === next) return;
    preview.src = next;
  }

  function render() {
    if (previewTimer !== null) clearTimeout(previewTimer);
    previewTimer = setTimeout(drawPreview, 200);

    // A light panel is invisible against the site's own paper background, so the frame goes
    // dark to stand in for the garment. Without this the panel looks like it does nothing.
    var frame = document.getElementById("forhandsvisning");
    if (frame) frame.classList.toggle("on-dark", state.platta === "ja");

    var hint = document.getElementById("underlagshint");
    if (hint) {
      hint.textContent = state.platta === "ja"
        ? "Svart kod på en vit platta, så den syns mot mörkt tyg. Vit kod direkt på tyget missas av äldre telefoner och många skannerappar, och tappar kontrasten dubbelt så fort i tvätten."
        : "Svart kod direkt på tyget. Bakgrunden är genomskinlig, så tröjan syns igenom.";
    }

    var count = document.getElementById("count");
    if (count) count.textContent = state.text.length + " / 14";

    var downloads = document.getElementById("downloads");
    if (downloads) {
      var garment = state.platta === "ja" ? "svart bakgrund" : "vit bakgrund";
      downloads.innerHTML = [
        [180, "Stora trycket", "180 mm, rygg"],
        [60, "Lilla trycket", "60 mm, bröst"],
      ].map(function (size) {
        return ["svg", "pdf"].map(function (format) {
          return row(
            size[1],
            size[2] + ", " + garment,
            url(size[0], true, format),
            // The garment goes in the filename. A dark-garment file is white panel, white text
            // and a dark code, so opened on a white screen it looks like the text is missing.
            // It is not; but whoever opens it at the print shop should not have to work that out.
            "ojhej-" + slug + "-" + size[0] + "mm-" +
              (state.platta === "ja" ? "svart" : "vit") + "." + format,
            format,
          );
        }).join("");
      }).join("");
    }
  }

  Array.prototype.forEach.call(designer.querySelectorAll("[data-platta]"), function (button) {
    button.addEventListener("click", function () {
      state.platta = button.getAttribute("data-platta");
      Array.prototype.forEach.call(designer.querySelectorAll("[data-platta]"), function (other) {
        other.setAttribute("aria-pressed", String(other === button));
      });
      render();
    });
  });

  var text = document.getElementById("text");
  if (text) {
    text.addEventListener("input", function () {
      state.text = text.value;
      render();
    });
  }

  render();
})();

/**
 * The purpose picker on /klar.
 *
 * Every preset carries its own text on the chip, as data attributes the server rendered, so this
 * file holds no copy of the presets. A second list here would be a second thing to reword, and
 * the one that got forgotten would be the one a stranger reads.
 *
 * Choosing a purpose sets two things at once: the text that goes above the printed code, and the
 * line on the scan page. The preview shows the second one, because it is the half the owner
 * cannot otherwise see until somebody scans.
 */
(function () {
  "use strict";

  var chips = document.getElementById("syfte");
  if (!chips) return;

  var text = document.getElementById("text");
  var egetfalt = document.getElementById("egetfalt");
  var egenrad = document.getElementById("egenrad");
  var radcount = document.getElementById("radcount");
  var forhandsrad = document.getElementById("forhandsrad");
  var tom = forhandsrad ? forhandsrad.getAttribute("data-tom") : "";

  function pressed() {
    return chips.querySelector('[aria-pressed="true"]');
  }

  function ritaRad() {
    var chip = pressed();
    if (!chip || !forhandsrad) return;
    var egen = chip.getAttribute("data-syfte") === "eget";
    var rad = egen ? (egenrad ? egenrad.value.trim() : "") : chip.getAttribute("data-rad");
    forhandsrad.textContent = rad || tom;
    forhandsrad.classList.toggle("rad--tom", !rad);
    if (radcount && egenrad) radcount.textContent = egenrad.value.length + " / 90";
  }

  Array.prototype.forEach.call(chips.querySelectorAll("[data-syfte]"), function (chip) {
    chip.addEventListener("click", function () {
      Array.prototype.forEach.call(chips.querySelectorAll("[data-syfte]"), function (other) {
        other.setAttribute("aria-pressed", String(other === chip));
      });

      var egen = chip.getAttribute("data-syfte") === "eget";
      if (egetfalt) egetfalt.hidden = !egen;

      if (text) {
        // The label follows the purpose, and stays editable afterwards. The event is what the
        // print designer listens to, so the preview and the downloads move with it.
        text.value = chip.getAttribute("data-etikett") || "";
        text.dispatchEvent(new Event("input", { bubbles: true }));
      }

      ritaRad();
      if (egen && egenrad) egenrad.focus();
    });
  });

  if (egenrad) egenrad.addEventListener("input", ritaRad);

  ritaRad();
})();

/**
 * Owner actions, on the code list and on /klar.
 *
 * The token is spent by this request, not by loading the page, so a mail gateway prefetching
 * the link cannot burn it before the owner arrives. Each successful action hands back a fresh
 * link, so the page stays usable without another trip to the inbox.
 *
 * Two shapes of answer. Most actions return somewhere to go; saving a purpose returns a fresh
 * token instead, because the page it was saved from is the page you want to stay on.
 */
(function () {
  "use strict";

  if (!window.OJHEJ_T) return;

  var fel = document.getElementById("fel");

  // Reveal the change-address panel. Same collapsing grid as the signup form, so the fields
  // inside stay out of the tab order' reach only visually; the panel is short and always in
  // the document, which keeps this a one-line toggle rather than a rendering decision.
  Array.prototype.forEach.call(document.querySelectorAll("[data-visa]"), function (button) {
    button.addEventListener("click", function () {
      var panel = document.querySelector(button.getAttribute("data-visa"));
      if (!panel) return;
      panel.classList.toggle("open");
      if (panel.classList.contains("open")) {
        var first = panel.querySelector("input");
        if (first) first.focus();
      }
    });
  });

  // Document-wide rather than scoped to the button group: the change-address action lives in
  // its own panel below it.
  Array.prototype.forEach.call(document.querySelectorAll("[data-atgard]"), function (button) {
    button.addEventListener("click", async function () {
      var confirmText = button.getAttribute("data-bekrafta");
      // Deleting is irreversible, so it asks. Pausing is not, so it does not.
      if (confirmText && !window.confirm(confirmText)) return;

      var atgard = button.getAttribute("data-atgard");
      var payload = { t: window.OJHEJ_T, atgard: atgard };

      // Which code this button acts on. Absent on the address-level actions, and absent on
      // /klar, where the token names the code by itself.
      var slug = button.getAttribute("data-slug");
      if (slug) payload.slug = slug;

      // Some actions carry a field. Checked here only to save a round trip: the server
      // validates the address itself and refuses before spending the link.
      var source = button.getAttribute("data-epost");
      if (source) {
        var input = document.querySelector(source);
        payload.epost = input ? input.value.trim() : "";
        if (!payload.epost) {
          if (fel) {
            fel.textContent = "Fyll i den nya adressen.";
            fel.style.display = "block";
          }
          if (input) input.focus();
          return;
        }
      }

      if (atgard === "syfte") {
        var chosen = document.querySelector('#syfte [aria-pressed="true"]');
        var label = document.getElementById("text");
        var own = document.getElementById("egenrad");
        payload.syfte = chosen ? chosen.getAttribute("data-syfte") : "hej";
        payload.etikett = label ? label.value : "";
        if (payload.syfte === "eget") payload.rad = own ? own.value : "";
      }

      button.disabled = true;
      if (fel) fel.style.display = "none";

      try {
        var response = await fetch("/api/hantera/atgard", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        var result = await response.json();

        if (response.ok && result.next) {
          // Some buttons want to land somewhere particular on the page they open, e.g. the
          // purpose picker rather than the top of it.
          window.location.href = result.next + (button.getAttribute("data-hash") || "");
          return;
        }

        if (response.ok && result.t) {
          // Saved without leaving. The old link is spent, so the page adopts the new one, and
          // the address bar follows it so a reload still works.
          window.OJHEJ_T = result.t;
          if (window.history && window.history.replaceState) {
            window.history.replaceState(null, "", "/klar?t=" + encodeURIComponent(result.t));
          }
          var sparat = document.getElementById("sparat");
          if (sparat) {
            sparat.style.display = "block";
            setTimeout(function () { sparat.style.display = "none"; }, 4000);
          }
          button.disabled = false;
          return;
        }

        if (fel) {
          fel.textContent = result.fel || "Det gick inte just nu.";
          fel.style.display = "block";
        }
      } catch (_) {
        if (fel) {
          fel.textContent = "Ingen kontakt med servern.";
          fel.style.display = "block";
        }
      }
      button.disabled = false;
    });
  });
})();

/**
 * The contact code in the footer, enlarged.
 *
 * Only for a fine pointer. Enlarging a code so it can be photographed is useful at a desk,
 * where the phone doing the scanning is a different device from the screen showing it, and
 * useless on the phone itself: nobody can scan their own screen. On touch the link is left
 * alone and simply opens our page.
 *
 * The markup is a link, so with no JavaScript this does nothing and the link still works.
 */
(function () {
  "use strict";

  var trigger = document.querySelector("[data-qr-open]");
  var dialog = document.getElementById("qr-dialog");
  if (!trigger || !dialog || typeof dialog.showModal !== "function") return;
  if (!window.matchMedia || !window.matchMedia("(pointer: fine)").matches) return;

  trigger.addEventListener("click", function (event) {
    event.preventDefault();
    // Fetched on first open, not on page load. The markup carries `data-src` so a browser does
    // not pull 40 KB of vector at parse time for a dialog most readers never open, and phones
    // never open at all.
    var big = dialog.querySelector("img[data-src]");
    if (big) {
      big.src = big.getAttribute("data-src");
      big.removeAttribute("data-src");
    }
    dialog.showModal();
  });

  var close = dialog.querySelector("[data-qr-close]");
  if (close) close.addEventListener("click", function () { dialog.close(); });

  // Clicking the backdrop closes it. The dialog element itself covers the whole viewport, so
  // "outside" means the click landed on the dialog box rather than on its contents.
  dialog.addEventListener("click", function (event) {
    if (event.target === dialog) dialog.close();
  });
})();

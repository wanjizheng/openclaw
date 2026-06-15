// Voice Call tests cover twiml plugin behavior.
import { describe, expect, it } from "vitest";
import { generateHybridNotifyTwiml, generateNotifyTwiml } from "./twiml.js";

describe("generateNotifyTwiml", () => {
  it("renders escaped xml with the requested voice", () => {
    expect(generateNotifyTwiml(`Call <ended> & "logged"`, "Polly.Joanna"))
      .toBe(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Call &lt;ended&gt; &amp; &quot;logged&quot;</Say>
  <Hangup/>
</Response>`);
  });
});

describe("generateHybridNotifyTwiml", () => {
  it("replaces Hangup with Pause length=30 to keep call in-progress for Call Update", () => {
    expect(generateHybridNotifyTwiml(`hello there`, "Polly.Joanna"))
      .toBe(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">hello there</Say>
  <Pause length="30"/>
</Response>`);
  });
  it("renders escaped xml with the requested voice", () => {
    expect(generateHybridNotifyTwiml(`Call <ended> & "logged"`, "Polly.Joanna"))
      .toBe(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Call &lt;ended&gt; &amp; &quot;logged&quot;</Say>
  <Pause length="30"/>
</Response>`);
  });
});

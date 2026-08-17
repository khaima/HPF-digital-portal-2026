// Community Resources chat — Supabase Edge Function.
//
// Called from app.js (pageCommunityResources / wireCommunityResources) via
// supabase.functions.invoke("community-resources-chat", { body: { message, area } }).
// The model API key lives only here, as the ANTHROPIC_API_KEY secret — never
// in app.js, which ships to every visitor's browser. See
// ../../COMMUNITY-RESOURCES.md for how to set the secret and deploy this.
//
// Deliberately public (no login required): community members asking about
// Maasai culture, education, healthcare or a Maa translation should not have
// to create an HPF account first. Deploy with --no-verify-jwt (see the doc).

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = "claude-sonnet-5";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `You are the community assistant for the Human Practice Foundation (HPF) Digital Portal, greeting people with "Jambo, How may I support you today?"

You help with exactly four kinds of question:
1. General information about Maasai community and culture — people, traditions, customs, the land.
2. Education — schools, learning, teacher training, staying in school.
3. Healthcare — clinics, maternal health, nutrition, where to get help.
4. Translation from any language into the Maa language (and explaining Maa words/phrases back in the asker's language).

Rules:
- Keep answers short, warm, and easy to read on a phone — a few sentences or a short list, not an essay.
- If asked something outside these four areas, say briefly that you focus on Maasai culture, education, healthcare and Maa translation, and invite them to ask about one of those.
- For anything urgent (medical emergency, safety, abuse), tell them to contact a local clinic, HPF staff, or local authorities directly rather than relying on this chat.
- If unsure of a Maa translation, say so rather than guessing confidently.
- Never invent specific HPF programme details, phone numbers, or statistics you don't know — speak in general terms instead.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  if (req.method !== "POST")
    return json({ error: "Method not allowed" }, 405);

  if (!ANTHROPIC_API_KEY)
    return json({ error: "Assistant is not configured yet (missing ANTHROPIC_API_KEY)." }, 500);

  let body: { message?: string; area?: string | null };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }

  const message = (body.message || "").trim().slice(0, 2000);
  if (!message) return json({ error: "Message is required." }, 400);

  const areaHint = body.area
    ? `\n\nThe visitor selected the "${body.area}" area before asking.`
    : "";

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        system: SYSTEM_PROMPT + areaHint,
        messages: [{ role: "user", content: message }],
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error("Anthropic API error", res.status, detail);
      return json({ error: "The assistant is temporarily unavailable." }, 502);
    }

    const data = await res.json();
    const reply = data?.content?.[0]?.text?.trim() || "Sorry, I don't have an answer for that right now.";
    return json({ reply });
  } catch (err) {
    console.error("community-resources-chat failed", err);
    return json({ error: "The assistant is temporarily unavailable." }, 502);
  }
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });
}

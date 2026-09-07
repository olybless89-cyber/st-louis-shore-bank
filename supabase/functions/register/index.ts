import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? ""
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

const jsonHeaders = { "Content-Type": "application/json", ...corsHeaders };

async function respond(status_code: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: status_code,
    headers: jsonHeaders,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  if (req.method !== "POST") {
    return await respond(405, { error: "Method not allowed" });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return await respond(400, { error: "Invalid JSON body" });
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const full_name = String(body.full_name ?? "").trim();

if (!email || !email.includes("@") || password.length < 6) {
    return await respond(400, { error: "Invalid email or password (min. 6 characters)" });
}

const pw = String(password);
if (pw.length < 6 || pw.length > 72) {
    return await respond(400, { error: "Password must be 6-72 characters" });
}

const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: pw,
    email_confirm: true,
    user_metadata: { full_name },
  });

if (error) {
    if (/(already|exists|registered)/i.test(error.message || "")) {
      return await respond(409, { error: "An account with this email already exists." });
    }
    return await respond(400, { error: error.message || "Registration failed" });
}

if (!data.user) {
    return await respond(500, { error: "Account creation failed" });
}

// Mint a session for the new user (confirmation is bypassed via email_confirm: true).
const { data: session, error: sessErr } = await supabase.auth.signInWithPassword({ email, password: pw });
if (sessErr || !session?.session) {
    return await respond(200, { user: { id: data.user.id, email: data.user.email } });
}

return await respond(200, {
    access_token: session.session.access_token,
    refresh_token: session.session.refresh_token,
    user: { id: session.session.user.id, email: session.session.user.email },
  });
});
// QuizLab · Sgiungla — notifica email per nuovi account pending
// Trigger previsto: Database Webhook su public.quizlab_user_access, evento INSERT.
// Segreti richiesti:
//   RESEND_API_KEY
//   QUIZLAB_ADMIN_EMAIL
// Facoltativo:
//   QUIZLAB_NOTIFY_FROM  (default: "QuizLab <onboarding@resend.dev>")

type AccessRecord = {
  user_id?: string;
  status?: string;
  updated_at?: string;
};

type WebhookPayload = {
  type?: string;
  table?: string;
  schema?: string;
  record?: AccessRecord | null;
  old_record?: AccessRecord | null;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const payload = (await req.json()) as WebhookPayload;

    if (
      payload.type !== "INSERT" ||
      payload.schema !== "public" ||
      payload.table !== "quizlab_user_access" ||
      payload.record?.status !== "pending" ||
      !payload.record?.user_id
    ) {
      return json({ ok: true, skipped: true });
    }

    const resendKey = Deno.env.get("RESEND_API_KEY");
    const adminEmail = Deno.env.get("QUIZLAB_ADMIN_EMAIL");
    const from = Deno.env.get("QUIZLAB_NOTIFY_FROM") || "QuizLab <onboarding@resend.dev>";
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!resendKey || !adminEmail || !supabaseUrl || !serviceRole) {
      return json({ error: "missing_server_secret" }, 500);
    }

    const userId = payload.record.user_id;

    // Recupera l'email dell'utente lato server: la service role non viene mai esposta al browser.
    const userRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      headers: {
        apikey: serviceRole,
        Authorization: `Bearer ${serviceRole}`,
      },
    });

    if (!userRes.ok) {
      const detail = await userRes.text();
      console.error("Auth admin lookup failed", userRes.status, detail);
      return json({ error: "user_lookup_failed" }, 502);
    }

    const user = await userRes.json();
    const email = user?.email || "(email non disponibile)";

    const subject = "QuizLab · nuova richiesta di accesso";
    const text =
      `Nuova richiesta QuizLab in attesa di approvazione.\n\nEmail: ${email}\nUser ID: ${userId}\n\nApri QuizLab con il tuo account amministratore e vai in Admin per approvare o rifiutare.`;

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;padding:24px">
        <h2 style="margin:0 0 16px">🌴 QuizLab · nuova richiesta</h2>
        <p>È arrivata una nuova richiesta di accesso in attesa di approvazione.</p>
        <div style="padding:14px;border:1px solid #ddd;border-radius:10px">
          <div><strong>Email:</strong> ${String(email).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")}</div>
          <div><strong>User ID:</strong> ${userId}</div>
        </div>
        <p>Apri QuizLab con il tuo account amministratore e vai in <strong>Admin</strong> per approvare o rifiutare.</p>
      </div>`;

    const mailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [adminEmail],
        subject,
        text,
        html,
      }),
    });

    const mailBody = await mailRes.text();
    if (!mailRes.ok) {
      console.error("Resend failed", mailRes.status, mailBody);
      return json({ error: "email_send_failed" }, 502);
    }

    return json({ ok: true });
  } catch (error) {
    console.error(error);
    return json({ error: "unexpected_error" }, 500);
  }
});

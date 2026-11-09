# Putting the New Light Orchestra site online

The site is hosted for free on **GitHub Pages**. Member logins, the music files and the
form sign-ups are stored in **Supabase**, which is also free at this size.

How the pieces fit together:

- **Public pages** (`index.html`) are plain files served by GitHub Pages.
- **Members** sign in with their email and a password they choose. When they first create their
  account, Supabase sends one email to confirm the address is really theirs; after that it's just
  email and password.
- **Only people on the members list** (managed on the Librarian tools page) can see the music.
  Someone who isn't on the list can create an account, but they'll see nothing.
- **Music files** live in a private Supabase storage bucket, *not* on GitHub. A file can't be
  downloaded without signing in as a member.
- **Join and mailing-list forms** save into Supabase. Admins read them on the Librarian tools page.

Allow about an hour for the steps below.

---

## 1. Create the Supabase project

1. Sign up at [supabase.com](https://supabase.com) and click **New project**.
2. Name it `new-light-orchestra`, choose a strong database password (save it in your
   password manager), and pick the region closest to you.
3. When it's ready, open **SQL Editor → New query**, paste in the whole of
   [`supabase/schema.sql`](supabase/schema.sql), and click **Run**.
4. Make yourself the first admin. Run this new query with your own details, with the email in lower case:

   ```sql
   insert into public.members (email, name, instrument, is_admin)
   values ('you@example.com', 'Your Name', 'Conductor', true);
   ```

## 2. Connect the site to Supabase

1. In Supabase, open **Project Settings → API** (it may be called **API Keys**).
2. Copy the **Project URL** and the **anon** (or **publishable**) key into
   [`config.js`](config.js), replacing `https://YOUR-PROJECT.supabase.co` and `YOUR-ANON-KEY`.

These two values are designed to be public. **Never** put the `service_role` or **secret** key in the site.

## 3. Set up account emails

Members get an email twice at most: once to confirm their address when they create their account,
and if they ever use "Forgot your password?". Supabase's built-in email sender only delivers to your
own Supabase team's addresses, and only a few emails an hour, so members need a proper email sender:

1. Create a free account with an email service such as [Resend](https://resend.com) or
   [Brevo](https://brevo.com). Add your domain if you have one; this stops emails going to spam.
2. In Supabase, open **Authentication → Emails → SMTP Settings**, turn on custom SMTP, and enter
   the details from that service. Use a sender like `New Light Orchestra <noreply@yourdomain>`.
3. Check **Authentication → Sign In / Providers → Email**: **Email** sign-in is on and
   **Confirm email** is on. Confirm email must stay on; it's what stops a stranger creating an
   account with a member's (or your) email address.
4. Optional: under **Authentication → Emails → Templates**, rewrite **Confirm signup** and
   **Reset password** so they mention New Light Orchestra.

## 4. Put the site on GitHub Pages

1. Create a GitHub account and a **new public repository**, e.g. `new-light-orchestra`.
   (Free GitHub Pages needs a public repository. That's fine: no music or member details are in it.)
2. Upload this folder to it. Use **Add file → Upload files** on GitHub, or `git push` if you use Git.
3. In the repository, open **Settings → Pages**, set **Source** to *Deploy from a branch*,
   choose **main** and **/ (root)**, and save.
4. After a minute the site is live at `https://<your-username>.github.io/new-light-orchestra/`.

## 5. Tell Supabase where the site lives

In Supabase, open **Authentication → URL Configuration**:

- **Site URL:** your site address, e.g. `https://<your-username>.github.io/new-light-orchestra/`
- **Redirect URLs:** add `https://<your-username>.github.io/new-light-orchestra/**`
  (and later your own domain, e.g. `https://newlightorchestra.org/**`)

The links in confirmation and password-reset emails only work for addresses in this list.

## 6. Try it out

1. Open `members.html` on your live site and click **Create your account** (or, if you signed in
   before passwords were added, **Forgot your password?** to set one).
2. Click **Librarian tools**. Add a piece (e.g. *Ode to Joy*), then upload the sample parts from
   [`supabase/sample-music/`](supabase/sample-music/) with matching instrument names.
3. Add a couple of members, then ask them to open the members page and click **Create your account**.

When you export parts from MuseScore, use **File → Export → MusicXML** and choose
**uncompressed** (`.musicxml`). Make sure each part's instrument name matches the members' instruments
(e.g. "Violin I"). That's how each member's own part is shown first.

## 7. Optional: your own domain

Buy a domain (e.g. `newlightorchestra.org`, around £10–15 a year), then follow GitHub's
[custom domain guide](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site).
Add the new address to Supabase's Redirect URLs (step 5).

---

## 8. Automatic emails

The function in `supabase/functions/join-request-email/index.ts` sends:

- a thank-you to anyone who fills in "Register your interest", plus a copy to the orchestra;
- a welcome email, with a link to Members sign up, to anyone the librarian adds as a member.
  It isn't sent to someone who already has an account.

To set it up:

1. **Edge Functions → Deploy a new function** (or open `join-request-email` to update it): name it
   `join-request-email`, paste the file in, and deploy. Leave **Verify JWT** on.
2. **Edge Functions → Secrets:** add `RESEND_API_KEY`.
3. **Database → Webhooks → Create a new hook**, once for each table:
   - `join_requests`, event **Insert**;
   - `members`, event **Insert**.

   For each one, choose **Supabase Edge Functions** → `join-request-email`, method POST, and add the
   **Authorization** header with the service key (the dashboard offers it).

## Keeping it running

- **Pausing:** Supabase pauses free projects after a week with no activity. The workflow in
  `.github/workflows/keep-alive.yml` pings it twice a week. GitHub stops scheduled workflows
  in repositories with no commits for 60 days. If that happens you'll get an email; click
  **Enable workflow** in the repository's **Actions** tab. If the project ever does pause,
  restore it from the Supabase dashboard.
- **Free limits** (check current pricing): about 50,000 monthly sign-ins and 1 GB of file
  storage, far more than an orchestra's MusicXML parts need.
- **Testing changes on your computer:** run `python3 -m http.server 8000` in this folder, open
  `http://localhost:8000`, and add `http://localhost:8000/**` to Supabase's Redirect URLs.

## A note on copyright

Signing in stops the public seeing your parts, but members can still download them. Upload only music
you're licensed to share with your members, and remind players it's for their own practice.

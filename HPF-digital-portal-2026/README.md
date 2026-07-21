# Human Practice Foundation — Digital Portal

**Live site:** https://khaima.github.io/HPF-digital-portal-2026/

A faithful rebuild of the HPF Digital Portal, running fully on **localhost** with
**zero build step and zero dependencies** — just Python (already on your machine).

> _"When actions flow from the heart. That's human practice."_

## What it is

A single-page application (vanilla ES modules + a small design system) that mirrors
the original portal's structure, copy, and design tokens:

- **Home** — two-column hero with a classroom photo, portal modules, About HPF,
  animated impact stats, contact
- **Curriculum** — teacher training modules
- **Learning Resources** — digital learning catalogue
- **Assessment Tools** — assessments, observation tools, reporting + impact stats
- **Field Officer App** — login-gated portal to record monitoring & evaluation visits
- **My Dashboard** — interactive, role-based dashboards with simulated data
- **Auth** — login / sign up with role-aware validation (Teacher, School Leader,
  Field Officer, Learner, HPF Admin), Kenyan counties & organization types

Authentication and field reports are stored client-side in `localStorage`, so the
whole experience works offline with no backend to configure.

### Key features

- **Two-column hero** matching the reference design, with the original classroom photo.
- **Login repository + admin push.** Every login and signup is stored in a dummy
  repository (`hpf_login_events` in `localStorage`) and "pushed" to the admin
  **patrick@humanpractice.org**, where it appears in the Admin dashboard's
  *Login requests inbox*.
- **Numbers animate from zero every 5 seconds** while the tab is active (they pause
  naturally when the tab is backgrounded).
- **My Dashboard** shows a purpose-built dashboard for the signed-in user, with a role
  switcher to view all five workspaces. Each opens with a banner spelling out what that
  role can **see and do**:

  | Role | See | Do |
  |------|-----|----|
  | **Admin** | Platform totals, login-request inbox, users-by-role, weekly logins, activity | **Manage users** — add accounts, change roles inline, remove users |
  | **Learner** | Kolibri-style **Learn** view: *Home / Library / Bookmarks*, your classes, "Continue learning" and content cards (video, exercise, reading, audio, interactive) with progress | Browse & **search the library**, filter by channel, click a resource to **resume** (progress advances) |
  | **Teacher** | Kolibri-style **Coach** view with three tabs — **Overview** (cumulative results: class status distribution, completion & average score per assignment), **Assignments**, and **Learners** | **Assign** a lesson / exercise / quiz to the whole class or selected learners, **track each learner's progress** per assignment (tap a learner for their detail), and watch **cumulative class results** update live |
  | **Field Officer** | Assigned schools & health, field tasks, visits logged | Complete tasks, open the field data-collection tool |
  | **School Leader** | School KPIs, performance by grade, staff ratings, attendance trend | **Generate a term report**, review individual staff |

### Demo admin account

A demo admin is seeded automatically on first load:

```
email:    patrick@humanpractice.org
password: admin1234
```

Sign in with it to see the login-request inbox and every role dashboard.

## Run it

You need Python 3 (check with `python --version` or `py --version`).

### Windows

```powershell
py server.py
```

or double-click **`start.bat`**.

### macOS / Linux

```bash
python3 server.py
```

or run **`./start.sh`**.

Then open **http://localhost:5173**

To use a different port: `py server.py 8080`

The included `server.py` serves the static files and falls back to `index.html`
for app routes, so clean URLs like `/curriculum` and `/field-officer` work even on
a hard refresh.

## Try the Field Officer flow

1. Click **Login** → **Sign up**
2. Choose role **Field Officer**, enter any email + password (6+ chars), pick a county
3. You're taken to the Field Officer dashboard
4. Submit a **field report** — watch the stats and submissions list update live
5. Refresh the page — your session and reports persist

> HPF Staff (Admin) sign-up requires an `@humanpractice.org` email.
> Learners sign up with a username instead of an email.

## Project structure

```
index.html              App shell + font/style links
styles.css              Design system (colors, layout, components, charts)
data.js                 Content + simulated dashboard data
icons.js                Inline SVG icon set
util.js                 Helpers + global count-up controller (5s loop)
dashboards.js           Role-based "My Dashboard" views & interactions
app.js                  SPA router, auth + login repository, views
assets/hero-classroom.jpg   Hero image (the original portal's photo)
favicon.ico             Original favicon
server.py               Static server with SPA route fallback
start.bat / start.sh    Launchers
```

## Notes

- **No installs, no Node, no npm.** Pure static assets served by Python's stdlib.
- Uses the system font stack — exactly like the original portal, so nothing is downloaded.
- All data lives in your browser's `localStorage` — clearing site data resets it.

/* ============================================================
   Content data for the HPF Digital Portal
   (Mirrors the copy & structure of the original portal)
   ============================================================ */

export const PORTAL_CARDS = [
  {
    icon: "graduation",
    title: "Teacher Training Curriculum",
    desc: "Professional development modules, training manuals, facilitator guides, and certification resources.",
    cta: "Open Curriculum",
    href: "/curriculum",
  },
  {
    icon: "bookOpen",
    title: "Digital Learning Resources",
    desc: "Interactive learning materials, lesson plans, videos, worksheets, and classroom resources.",
    cta: "Browse Resources",
    href: "/resources",
  },
  {
    icon: "clipboard",
    title: "Assessment Tools",
    desc: "Student assessments, baseline tools, classroom observation instruments, and reporting templates.",
    cta: "Launch Assessment Tools",
    href: "/assessment",
  },
  {
    icon: "smartphone",
    title: "Field Officer Application",
    desc: "Secure portal for HPF field officers to collect monitoring, evaluation, and school support data.",
    cta: "Staff only · Login",
    href: "/field-officer",
    variant: "primary",
  },
];

export const CURRICULUM = [
  {
    icon: "book",
    title: "Teacher Training Manual",
    desc: "Comprehensive facilitator guide for HPF's core teacher training programme.",
  },
  {
    icon: "sparkles",
    title: "Competency-Based Learning",
    desc: "Aligned resources supporting CBC and competency-based classrooms.",
  },
  {
    icon: "file",
    title: "Lesson Plans",
    desc: "Ready-to-use lesson plans across subjects and grade levels.",
  },
];

export const RESOURCES = [
  {
    icon: "book",
    title: "Teacher Training Manual",
    desc: "Comprehensive facilitator guide for HPF's core teacher training programme.",
  },
  {
    icon: "sparkles",
    title: "Competency-Based Learning",
    desc: "Aligned resources supporting CBC and competency-based classrooms.",
  },
  {
    icon: "file",
    title: "Lesson Plans",
    desc: "Ready-to-use lesson plans across subjects and grade levels.",
  },
  {
    icon: "pen",
    title: "Literacy Resources",
    desc: "Foundational reading and writing materials for early learners.",
  },
  {
    icon: "calculator",
    title: "Numeracy Resources",
    desc: "Hands-on activities to strengthen numeracy and problem solving.",
  },
  {
    icon: "eye",
    title: "Classroom Observation Tool",
    desc: "Structured tool for coaching and quality assurance visits.",
  },
  {
    icon: "wrench",
    title: "School Improvement Toolkit",
    desc: "Planning templates and diagnostics for school leaders.",
  },
  {
    icon: "library",
    title: "Digital Library",
    desc: "Growing catalogue of curated educational media and readings.",
  },
];

export const ASSESSMENT = [
  {
    icon: "clipboard",
    title: "Student Assessments",
    desc: "Structured assessments for measuring learner competencies across subjects.",
  },
  {
    icon: "eye",
    title: "Classroom Observation Tool",
    desc: "Standardised instruments for coaching and quality assurance visits.",
  },
  {
    icon: "file",
    title: "Reporting Templates",
    desc: "Baseline and progress reporting templates for schools and field officers.",
  },
];

export const IMPACT = [
  { num: 30, suffix: "+", label: "Schools Supported", icon: "school" },
  { num: 10000, suffix: "+", label: "Learners Reached", icon: "users" },
  { num: 500, suffix: "+", label: "Teachers Trained", icon: "userCheck" },
  { num: 4, suffix: "", label: "Counties Served", icon: "mapPin" },
];

/* Programme targets the admin KPI cards measure against. Anchored to the
   public IMPACT figures above where they line up — learners to the 10,000
   reached, users to the 500 teachers trained — but these are the numbers HPF
   should own. Edit them here; the cards derive their progress bars and
   percentages from whatever is set. */
export const KPI_TARGETS = {
  users: 500,          // registered accounts across every role
  learners: 10000,     // learners enrolled in a class
  assessments: 1000,   // assessments completed and submitted
  liveSessions: 10,    // lessons or quizzes running at once
};

/* HPF's Child Empowerment Model. Three pillars, each with the groups that sit
   under it, read across starting at Fundamentals — the same order as the
   programme diagram. Icons are the nearest match from icons.js: the site draws
   one inline SVG family and the deployed page's CSP blocks remote images, so
   the deck's artwork cannot be dropped in as-is. */
export const EMPOWERMENT_MODEL = [
  {
    pillar: "School Infrastructure",
    icon: "school",
    groups: [
      { title: "Fundamentals", icon: "home",
        items: ["Classrooms", "Dormitories", "Administration blocks", "Teachers' houses", "Dining halls & kitchens"] },
      { title: "Education facilities", icon: "library",
        items: ["Libraries", "Playgrounds", "Solar systems", "Fences"] },
      { title: "Water & Sanitation Facilities", icon: "cloud",
        items: ["Toilets", "Water systems"] },
    ],
  },
  {
    pillar: "Learning",
    icon: "bookOpen",
    groups: [
      { title: "Teachers", icon: "userCheck",
        items: ["Teacher Professional Development (TPD)"] },
      { title: "Learners", icon: "graduation",
        items: ["Foundational skills (Literacy & Numeracy)", "Socio-emotional learning (SEL)", "Transitions"] },
      { title: "Leadership", icon: "users",
        items: ["Leadership training", "Excellence program"] },
    ],
  },
  {
    pillar: "Economic Empowerment",
    icon: "trendingUp",
    groups: [
      { title: "Vocational Training", icon: "laptop",
        items: ["IT Academy"] },
      { title: "Micro-Enterprise", icon: "calculator",
        items: ["Village Savings and Loans Associations", "Entrepreneurship", "Seed funding", "Income generating activities"] },
    ],
  },
];

export const ABOUT_POINTS = [
  "Strengthening schools with practical, sustainable systems",
  "Empowering teachers through hands-on professional development",
  "Supporting learners with quality, competency-based education",
];

export const ROLES = [
  { value: "teacher", label: "Teacher" },
  { value: "school_leader", label: "School Leader" },
  { value: "field_officer", label: "Field Officer" },
  { value: "learner", label: "Learner" },
  { value: "me_officer", label: "M&E" },
  { value: "programme_manager", label: "Programme Manager" },
  { value: "admin", label: "HPF Admin" },
];

// Self-serve signup only ever offers these — handle_new_user() (patch-01)
// clamps anything else to "learner" server-side, so a role that isn't in
// this list would be a working button that silently does something else.
// programme_manager, me_officer and admin are never reachable by signing up
// — all three are granted by an existing account with people.edit access
// inviting someone (dashboards.js, createStaffAccount), never typed at
// signup. "staff" is the pre-patch-22 tier: no longer offered anywhere,
// existing rows migrated to programme_manager, kept in the enum only
// because Postgres cannot drop an enum value.
export const NON_SELF_SERVE_ROLES = ["admin", "programme_manager", "me_officer", "staff"];
export const SELF_SERVE_ROLES = ROLES.filter(
  (r) => !NON_SELF_SERVE_ROLES.includes(r.value)
);

export const ORG_TYPES = [
  "Public Primary School",
  "Public Secondary School",
  "Private Primary School",
  "Private Secondary School",
  "TVET Institution",
  "University / College",
  "NGO / Non-profit",
  "Government Agency",
  "Other",
];

export const COUNTIES = [
  "Baringo", "Bomet", "Bungoma", "Busia", "Elgeyo-Marakwet", "Embu", "Garissa",
  "Homa Bay", "Isiolo", "Kajiado", "Kakamega", "Kericho", "Kiambu", "Kilifi",
  "Kirinyaga", "Kisii", "Kisumu", "Kitui", "Kwale", "Laikipia", "Lamu",
  "Machakos", "Makueni", "Mandera", "Marsabit", "Meru", "Migori", "Mombasa",
  "Murang'a", "Nairobi", "Nakuru", "Nandi", "Narok", "Nyamira", "Nyandarua",
  "Nyeri", "Samburu", "Siaya", "Taita-Taveta", "Tana River", "Tharaka-Nithi",
  "Trans Nzoia", "Turkana", "Uasin Gishu", "Vihiga", "Wajir", "West Pokot",
];

/* Hero tagline — the italic lead rotates through these every 3 seconds,
   each followed by the constant "That's human practice." */
export const HERO_QUOTES = [
  "When actions flow from the heart.",
  "When word inspires but only action counts.",
  "When compassion is lived, not just felt.",
  "Change the future. Build the school.",
];

/* Hero carousel — the home page rotates these every 3 seconds.
   The floating badge changes with each slide. */
export const HERO_SLIDES = [
  {
    src: "assets/hero-classroom.jpg",
    alt: "A Human Practice Foundation teacher with young learners reading together in a Kenyan classroom",
    icon: "graduation",
    label: "Certified",
    value: "Teacher Programme",
  },
  {
    src: "assets/hero-school.jpg",
    alt: "A rural Kenyan primary school block with a veranda, set against open savannah",
    icon: "school",
    label: "Infrastructure",
    value: "School Building",
  },
  {
    src: "assets/hero-ict.jpg",
    alt: "Two young women working together on a laptop at the Human Practice Foundation IT Academy",
    icon: "laptop",
    label: "Digital Skills",
    value: "IT Academy",
  },
];

/* Digital library — categories, resource types, and a small seed set */
export const LIBRARY_CATEGORIES = [
  "Teacher Training", "Literacy", "Numeracy", "Science",
  "Life Skills", "CBC", "ICT Skills", "Other",
];

export const RESOURCE_TYPES = {
  document: { label: "Document", icon: "file" },
  video: { label: "Video", icon: "play" },
  audio: { label: "Audio", icon: "headphones" },
  link: { label: "Web link", icon: "link" },
  reading: { label: "Reading", icon: "book" },
};

/* The digital library's starting catalogue used to be seeded from here into
   each browser's localStorage. It is real HPF reference data, so it now lives
   in the patch sequence (patch-21) alongside patch-02's schools — one
   catalogue in the database, not one per browser. */

/* HPF-supported schools (teachers pick one when creating a class) */
/* HPF regions → the schools in each. Signup picks a region, then the
   school dropdown is filtered to that region. */
export const REGIONS = {
  Meru: ["Meru Primary School", "Kithoka Primary School", "Nkubu Primary School"],
  Isiolo: ["Akandeli Primary", "Shambani Primary School"],
  Laikipia: ["Nanyuki Primary School", "Rumuruti Primary School", "Doldol Primary School"],
  Narok: ["Naboisho Primary", "Ololomei Primary", "Maasai Mara High School", "Aitong Primary School",
          "Olesere Primary School", "Mbitin Primary School", "Olkimitare Primary School",
          "Lemek Namunyak Secondary", "Olemoncho Primary School", "Ositeti Primary School",
          "Kutete Primary School", "Rekero Primary School", "Sekenani Primary School",
          "Laila Primary School", "Mpiro Primary School", "Ilndung'isho Primary School",
          "Pardamat Primary School", "Enkorika Secondary School", "Olkinyei Secondary School", "Nterere Primary Primary School"],
};

/* School names and GPS now live in Postgres — see supabase/patch-02-schools.sql,
   which seeded the table from the SCHOOL_COORDS constant that used to sit here.
   Correct a coordinate in the admin dashboard ("Manage schools"), not in code.
   NOTE: the seeded values are approximate placeholders for the region; each
   still wants a real GPS reading so the satellite view lands on the compound. */

/* HPF programme projects a user can belong to */
export const PROJECTS = ["Micro Enterprise Programme", "ICT Academy", "Infrastructure", "Education"];

/* flat list of every school (teacher class creation, scorecard, etc.) */
export const SCHOOLS = Object.values(REGIONS).flat();

/* Field Officer data-collection form: visit types. Each maps to the M&E
   scorecard pillar (me_indicators.scorecard_pillar) that the form's "Form"
   dropdown is filtered by once this visit type is picked — see
   supabase/FIELD-REPORT-FORMS.md. */
export const VISIT_TYPES = [
  { pillar: "education", label: "Learning" },
  { pillar: "infrastructure", label: "Infrastructure" },
  { pillar: "ict", label: "ICT" },
  { pillar: "mep", label: "MEP" },
];

/* ============================================================
   DASH / KOLIBRI (the last simulated "My Dashboard" data — admin, teacher,
   field_officer and school_leader's DASH entries, and KOLIBRI.coach, were
   already removed once real Supabase sources existed) were deleted
   outright on 2026-09-01: the trigger condition their own removal comment
   named — "won't [be real] until the assignments/assessments/submissions
   Postgres migration lands and a product decision is made about what a
   streak or badge means in a real database" — is met. That migration
   shipped (patch-13 onward; `submissions.learner_id` fixed to reference
   `learners(id)` in patch-31), and the product decision is in
   supabase/LEARNER-EXPERIENCE-SPEC.md §"12. Achievements": not genuinely
   required — no HPF outcome indicator this programme tracks (attendance,
   dropout, learning outcomes) is a streak or a badge, and neither had any
   real data behind it. `learnerBody()` in dashboards.js now computes its
   stats from real `assignments`/`assessments`/`submissions` data via
   learnerAssignments(), not from a constant here. See LEARNER-EXPERIENCE-
   SPEC.md for the full design this replaces it with.
   ============================================================ */


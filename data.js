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
  { value: "staff", label: "HPF Staff" },
  { value: "admin", label: "HPF Admin" },
];

// Self-serve signup only ever offers these — handle_new_user() (patch-01)
// clamps anything else to "learner" server-side, so a role that isn't in
// this list would be a working button that silently does something else.
// Neither "staff" nor "admin" is reachable by signing up; both are granted
// by an existing staff/admin account promoting someone (dashboards.js).
export const SELF_SERVE_ROLES = ROLES.filter(
  (r) => r.value !== "staff" && r.value !== "admin"
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

export const LIBRARY_SEED = [
  { title: "HPF Teacher Training Manual", category: "Teacher Training", type: "document",
    description: "Comprehensive facilitator guide for HPF's core teacher training programme.",
    url: "https://humanpracticefoundation.org/" },
  { title: "Foundational Literacy Pack", category: "Literacy", type: "reading",
    description: "Early-grade reading and phonics materials aligned to CBC.",
    url: "https://globaldigitallibrary.org/" },
  { title: "Numeracy Games & Activities", category: "Numeracy", type: "video",
    description: "Hands-on activities that make number sense stick.",
    url: "https://www.khanacademy.org/" },
  { title: "Intro to Digital Skills", category: "ICT Skills", type: "video",
    description: "Getting started with laptops, typing, and the internet — for the IT Academy.",
    url: "https://www.khanacademy.org/computing" },
];

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

/* Field Officer data-collection form: visit types */
export const VISIT_TYPES = [
  "Monitoring & Evaluation Visit",
  "School Support Visit",
  "Teacher Coaching Session",
  "Baseline Data Collection",
  "Classroom Observation",
  "Infrastructure Assessment",
];

/* ============================================================
   Simulated data for the role-based "My Dashboard".

   Only `learner` remains here. admin/teacher/field_officer/school_leader
   were removed once every widget that read them was rewired to a real
   Supabase source (or, where no real source exists yet — a per-school
   "health" score, teacher coaching ratings, per-grade competency scores —
   an honest "not yet tracked" state instead of an invented number). See
   dashboards.js: computeAdminStats(), fieldOfficerBody(), schoolLeaderBody().

   `learner` is still simulated: course progress, streak and badges have no
   real data behind them yet, and won't until the assignments/assessments/
   submissions Postgres migration lands and a product decision is made about
   what a "streak" or "badge" means in a real database.
   ============================================================ */

export const DASH = {
  learner: {
    stats: [
      { label: "Courses enrolled", count: 6, suffix: "", icon: "book",
        target: 8, freshMins: 30, href: "/resources", actionLabel: "Browse courses" },
      { label: "Lessons completed", count: 48, suffix: "", icon: "check", trend: 14,
        target: 60, freshMins: 15, href: "/curriculum", actionLabel: "Continue learning" },
      { label: "Day streak", count: 12, suffix: "", icon: "flame", trend: 9,
        target: 30, freshMins: 5, href: "/resources", actionLabel: "Keep it going" },
      { label: "Badges earned", count: 9, suffix: "", icon: "award", trend: 2,
        target: 15, freshMins: 120, href: "/assessment", actionLabel: "View progress" },
    ],
    courses: [
      { name: "Foundational Literacy", progress: 82 },
      { name: "Numeracy & Problem Solving", progress: 64 },
      { name: "Science Discovery", progress: 45 },
      { name: "Life Skills", progress: 90 },
    ],
    assignments: [
      { title: "Reading comprehension worksheet", due: "Today", done: false },
      { title: "Numeracy quiz — fractions", due: "Tomorrow", done: false },
      { title: "Science project outline", due: "In 3 days", done: false },
      { title: "Vocabulary practice", due: "Completed", done: true },
    ],
    weekly: [2, 3, 1, 4, 3, 5, 6],
  },

};

/* ============================================================
   Kolibri-style learning data — powers the Learn (learner) and
   Coach (teacher) dashboards.
   ============================================================ */

/* kind → colour + icon used on content thumbnails */
export const CONTENT_KINDS = {
  video: { label: "Video", icon: "play", color: "oklch(62% 0.24 27)" },
  exercise: { label: "Exercise", icon: "target", color: "oklch(52% 0.14 148)" },
  reading: { label: "Reading", icon: "book", color: "oklch(55% 0.15 300)" },
  audio: { label: "Audio", icon: "headphones", color: "oklch(68% 0.17 155)" },
  interactive: { label: "Interactive", icon: "puzzle", color: "oklch(78% 0.15 75)" },
};

/* shared content pool */
const R = (id, title, channel, kind, duration, progress) => ({
  id, title, channel, kind, duration, progress,
});

export const KOLIBRI = {
  learner: {
    classes: [
      { name: "Grade 6 — Blue", teacher: "Mr. Otieno", count: 24, color: "oklch(58% 0.2 264)" },
      { name: "Numeracy Club", teacher: "Ms. Achieng", count: 12, color: "oklch(60% 0.14 190)" },
    ],
    continue: [
      R("c1", "Adding & Subtracting Fractions", "Khan Academy", "video", "6:24", 60),
      R("c2", "Place Value — Practice", "Khan Academy", "exercise", "15 questions", 40),
      R("c3", "The Water Cycle", "CK-12 Science", "reading", "8 min read", 25),
    ],
    library: [
      R("l1", "Introduction to Fractions", "Khan Academy", "video", "5:10", 100),
      R("l2", "Multiplication Tables", "Khan Academy", "exercise", "20 questions", 80),
      R("l3", "Reading Comprehension: Folktales", "Global Digital Library", "reading", "12 min read", 0),
      R("l4", "Story Time: The Clever Hare", "African Storybook", "audio", "9:45", 0),
      R("l5", "Balancing Forces", "PhET Simulations", "interactive", "Simulation", 30),
      R("l6", "Shapes & Angles", "CK-12 Math", "video", "7:32", 0),
      R("l7", "Spelling Challenge", "Blockly Games", "exercise", "10 questions", 55),
      R("l8", "Photosynthesis Explained", "TED-Ed", "video", "4:18", 0),
      R("l9", "Counting Money", "Khan Academy", "interactive", "Activity", 0),
    ],
    bookmarks: [
      R("b1", "Balancing Forces", "PhET Simulations", "interactive", "Simulation", 30),
      R("b2", "Photosynthesis Explained", "TED-Ed", "video", "4:18", 0),
    ],
    channels: ["All", "Khan Academy", "CK-12", "Global Digital Library", "PhET Simulations", "TED-Ed"],
  },
  // coach (teacher-facing) was removed: the coach dashboard has run on real
  // class/assignment/assessment data (hpf_classes, now Postgres-backed for
  // the class shell) since the classes/enrollments migration. The one line
  // that still read this — "Class activity" on the Overview tab — now
  // computes from real local submissions instead (dashboards.js,
  // coachOverview()).
};


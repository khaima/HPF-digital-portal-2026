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
  { value: "admin", label: "HPF Staff (Admin)" },
];

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

/* HPF-supported schools (teachers pick one when creating a class) */
export const SCHOOLS = [
  "Aitong School",
  "Naboisho School",
  "Ololomei School",
  "Olkimitare School",
];

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
   Simulated data for the role-based "My Dashboard"
   ============================================================ */

export const DASH = {
  admin: {
    stats: [
      { label: "Total users", count: 1284, suffix: "", icon: "users", trend: 4.2 },
      { label: "Active schools", count: 32, suffix: "", icon: "school", trend: 6.7 },
      { label: "Login requests (today)", count: 148, suffix: "", icon: "inbox", trend: 64 },
      { label: "Learners reached", count: 10000, suffix: "+", compact: true, icon: "trendingUp", trend: 12 },
    ],
    roleBreakdown: [
      { label: "Learners", value: 820, color: "oklch(52% 0.14 148)" },
      { label: "Teachers", value: 312, color: "oklch(68% 0.17 155)" },
      { label: "School Leaders", value: 84, color: "oklch(78% 0.15 75)" },
      { label: "Field Officers", value: 46, color: "oklch(55% 0.15 300)" },
      { label: "Admins", value: 22, color: "oklch(62% 0.24 27)" },
    ],
    weekly: [42, 61, 55, 78, 66, 90, 148],
    activity: [
      { who: "Grace Achieng", act: "created a Teacher account", role: "teacher" },
      { who: "Nyeri Hill Primary", act: "submitted a field report", role: "field_officer" },
      { who: "Daniel Kipkoech", act: "completed Numeracy Module 3", role: "learner" },
      { who: "St. Mary's School", act: "updated enrollment data", role: "school_leader" },
      { who: "Mercy Wafula", act: "requested audience access", role: "teacher" },
    ],
  },

  learner: {
    stats: [
      { label: "Courses enrolled", count: 6, suffix: "", icon: "book" },
      { label: "Lessons completed", count: 48, suffix: "", icon: "check", trend: 14 },
      { label: "Day streak", count: 12, suffix: "", icon: "flame", trend: 9 },
      { label: "Badges earned", count: 9, suffix: "", icon: "award", trend: 2 },
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

  teacher: {
    stats: [
      { label: "My classes", count: 4, suffix: "", icon: "users" },
      { label: "Students", count: 156, suffix: "", icon: "graduation" },
      { label: "Lesson plans", count: 38, suffix: "", icon: "file" },
      { label: "Avg. attendance", count: 92, suffix: "%", icon: "check" },
    ],
    classes: [
      { name: "Grade 4 — Blue", students: 42, attendance: 94 },
      { name: "Grade 5 — Green", students: 38, attendance: 89 },
      { name: "Grade 6 — Yellow", students: 40, attendance: 95 },
      { name: "Grade 6 — Red", students: 36, attendance: 90 },
    ],
    tasks: [
      { title: "Mark Grade 5 numeracy quiz", due: "Today", done: false },
      { title: "Prepare CBC lesson plan — Week 6", due: "Tomorrow", done: false },
      { title: "Submit attendance register", due: "Today", done: false },
      { title: "Upload term assessment scores", due: "Done", done: true },
    ],
    weekly: [88, 91, 90, 93, 89, 95, 92],
  },

  field_officer: {
    stats: [
      { label: "Assigned schools", count: 14, suffix: "", icon: "school" },
      { label: "Visits this month", count: 27, suffix: "", icon: "mapPin", trend: 8 },
      { label: "Reports synced", count: 24, suffix: "", icon: "cloud", trend: 4 },
      { label: "Pending reviews", count: 3, suffix: "", icon: "clock", trend: -25 },
    ],
    schools: [
      { name: "Nyeri Hill Primary", county: "Nyeri", status: "Visited", health: 86 },
      { name: "Kisumu Central Academy", county: "Kisumu", status: "Scheduled", health: 72 },
      { name: "Turkana Star School", county: "Turkana", status: "Visited", health: 65 },
      { name: "Mombasa Coast Primary", county: "Mombasa", status: "Needs visit", health: 58 },
    ],
    tasks: [
      { title: "Upload Turkana baseline data", due: "Today", done: false },
      { title: "Coaching session — Kisumu Central", due: "Tomorrow", done: false },
      { title: "Sync offline reports", due: "Today", done: false },
      { title: "Infrastructure audit — Mombasa", due: "Done", done: true },
    ],
    weekly: [3, 5, 4, 6, 5, 2, 2],
  },

  school_leader: {
    stats: [
      { label: "Enrolled learners", count: 640, suffix: "", icon: "graduation", trend: 3 },
      { label: "Teaching staff", count: 28, suffix: "", icon: "users" },
      { label: "Attendance rate", count: 93, suffix: "%", icon: "userCheck", trend: 2 },
      { label: "Improvement score", count: 78, suffix: "/100", icon: "trendingUp", trend: 6 },
    ],
    grades: [
      { label: "Grade 4", value: 88 },
      { label: "Grade 5", value: 81 },
      { label: "Grade 6", value: 76 },
      { label: "Grade 7", value: 84 },
      { label: "Grade 8", value: 79 },
    ],
    teachers: [
      { name: "Grace Achieng", subject: "Literacy", rating: 4.8 },
      { name: "Peter Otieno", subject: "Numeracy", rating: 4.5 },
      { name: "Mercy Wafula", subject: "Science", rating: 4.7 },
      { name: "John Mwangi", subject: "Life Skills", rating: 4.3 },
    ],
    weekly: [90, 92, 91, 94, 93, 95, 93],
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

  coach: {
    className: "Grade 6 — Blue",
    learners: [
      { id: "l1", name: "Amina Hassan", active: "2h ago" },
      { id: "l2", name: "Brian Kimani", active: "1d ago" },
      { id: "l3", name: "Catherine Auma", active: "3h ago" },
      { id: "l4", name: "David Mutua", active: "2d ago" },
      { id: "l5", name: "Esther Njeri", active: "5h ago" },
      { id: "l6", name: "Felix Omondi", active: "4d ago" },
    ],
    // Each assignment tracks per-learner progress (pct) and, for
    // exercises/quizzes, a score. Status is derived from pct.
    assignments: [
      {
        id: "a1", type: "lesson", title: "Fractions — Introduction",
        detail: "4 resources", due: "in 2 days",
        results: [
          { id: "l1", pct: 100 }, { id: "l2", pct: 100 }, { id: "l3", pct: 60 },
          { id: "l4", pct: 40 }, { id: "l5", pct: 100 }, { id: "l6", pct: 20 },
        ],
      },
      {
        id: "a2", type: "lesson", title: "Place Value & Rounding",
        detail: "3 resources", due: "in 5 days",
        results: [
          { id: "l1", pct: 100 }, { id: "l2", pct: 80 }, { id: "l3", pct: 100 },
          { id: "l4", pct: 20 }, { id: "l5", pct: 60 }, { id: "l6", pct: 0 },
        ],
      },
      {
        id: "a3", type: "exercise", title: "Multiplication Practice",
        detail: "20 questions", due: "Today",
        results: [
          { id: "l1", pct: 100, score: 92 }, { id: "l2", pct: 100, score: 80 },
          { id: "l3", pct: 60, score: 70 }, { id: "l4", pct: 0, score: 0 },
          { id: "l5", pct: 100, score: 88 }, { id: "l6", pct: 40, score: 55 },
        ],
      },
      {
        id: "a4", type: "quiz", title: "Numeracy Quiz 1",
        detail: "10 questions", due: "Yesterday",
        results: [
          { id: "l1", pct: 100, score: 88 }, { id: "l2", pct: 100, score: 81 },
          { id: "l3", pct: 100, score: 72 }, { id: "l4", pct: 100, score: 60 },
          { id: "l5", pct: 100, score: 90 }, { id: "l6", pct: 0, score: 0 },
        ],
      },
      {
        id: "a5", type: "quiz", title: "Fractions Check-in",
        detail: "8 questions", due: "in 3 days",
        results: [
          { id: "l1", pct: 100, score: 84 }, { id: "l2", pct: 100, score: 78 },
          { id: "l3", pct: 60, score: 0 }, { id: "l4", pct: 0, score: 0 },
          { id: "l5", pct: 100, score: 80 }, { id: "l6", pct: 0, score: 0 },
        ],
      },
    ],
    activity: [
      { who: "Amina Hassan", what: "completed “Adding Fractions” video", when: "2h ago" },
      { who: "Esther Njeri", what: "scored 90% on Numeracy Quiz 1", when: "5h ago" },
      { who: "Catherine Auma", what: "started “The Water Cycle”", when: "3h ago" },
      { who: "Brian Kimani", what: "needs help on Place Value exercise", when: "1d ago" },
    ],
  },
};


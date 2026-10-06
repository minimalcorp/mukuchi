import {
  list,
  record,
  type AlwaysRow,
  type CtaText,
  type DemoStep,
  type Feature,
  type IconItem,
  type InputMode,
  type ModeCardText,
  type Step,
} from "../lib/content";
import type { Platform } from "../lib/platform";
import { DMG_SIZE_MB, MODELS, SETUP_MINUTES, SHORTCUT, VERSION, formatGb } from "../lib/site";
import type { Messages } from "./ja";

// 英語の辞書。日本語の直訳ではなく英語の LP として自然な文にする (数値・事実は日本語と同じ。誇張しない)。
// 英語を話す人向けのページなので、モデルは話す言語 en の推奨 (MODELS.en) を出す

const MODEL = MODELS.en;
const MODEL_SIZE = `about ${formatGb("en", MODEL.bytes)} GB`;
const DMG_SIZE = `${DMG_SIZE_MB} MB`;
const PRICE = "Free";

const L1 = "Please review the validation on the login screen.";
const L2 = " Also make the error messages consistent.";
const M1 = "Next week's team meeting moves to Thursday at 10 a.m.";

const ONLY_APPLE_SILICON = "Currently available only for Macs with Apple Silicon";

export const en = {
  meta: {
    title: "mukuchi | Just speak. Only your words get typed.",
    description:
      "mukuchi is a voice input app that stays running on your Mac. It picks up only your speech, transcribes it, and types it straight into the app in front. All speech recognition runs on your device.",
    ogImage: "/og-image-en.jpg",
    ogImageAlt: "mukuchi — a voice input app that stays running on your Mac",
  },

  shareText: "mukuchi, a voice input app for Mac",

  nav: {
    label: "On this page",
    modes: "Modes",
    features: "Features",
    privacy: "Privacy",
    setup: "Setup",
    language: "Language",
  },

  hero: {
    title: ["Just speak.", "Only your words get typed."],
    body: "mukuchi is a voice input app that stays running on your Mac. It detects when you speak, transcribes your words, and types them at the cursor in the app you're using. Leave it on, and your text keeps flowing as you talk.",
    once: { before: "With people around, press", after: "to dictate one utterance at a time." },
    macOnly: "mukuchi is a Mac app. Open this page in a browser on your Mac to download it.",
    github: "View on GitHub",
  },

  downloadMeta: `${VERSION} · ${PRICE} · Apple Silicon (M1 or later) only · ${DMG_SIZE}`,
  downloadMetaShort: `${VERSION} · ${PRICE} · Apple Silicon only`,

  cta: {
    download: { label: "Download for Mac", short: "Download" },
    states: record<Platform, CtaText>({
      "mac-arm": { note: "Mac with Apple Silicon detected" },
      "mac-unknown": { note: "Does not run on Intel-based Macs" },
      "mac-intel": {
        label: "Apple Silicon only",
        short: "Not supported",
        note: "Intel-based Macs are not supported",
      },
      windows: {
        label: "Windows version planned",
        short: "Planned",
        note: ONLY_APPLE_SILICON,
      },
      linux: {
        label: "Linux version planned",
        short: "Planned",
        note: ONLY_APPLE_SILICON,
      },
      mobile: {
        label: "Download on your Mac",
        short: "Mac only",
        note: "Open this page in a browser on your Mac",
      },
      other: {
        label: "Desktop only",
        short: "Mac only",
        note: "Visit this page from a Mac with Apple Silicon",
      },
    }),
    copyUrl: "Copy URL",
    copied: "Copied",
    share: "Share",
    platforms: {
      mac: "macOS (Apple Silicon)",
      available: "Available",
      comingSoon: "Planned",
    },
  },

  modes: {
    title: { lead: "Choose between ", rest: "two listening modes" },
    lead: "“Always listen” is the default. When people are around, or when you want to decide exactly when to type, use “Listen once.” You pick a mode during setup and can change it anytime in Settings.",
    names: { always: "Always listen", once: "Listen once" } satisfies Record<InputMode, string>,
    defaultBadge: "Default",
    whenLabel: "Good for",
    cards: record<InputMode, ModeCardText>({
      always: {
        body: "While it's on, everything you say is transcribed and typed. Nothing is typed while you're silent.",
        segs: [
          { f: 1, t: "On: types each utterance", tSp: "On: types each utterance", active: true },
        ],
        when: ["Working on your own", "Typing one thing after another just by talking"],
        keys: [{ when: "", does: "Turns voice input on or off" }],
      },
      once: {
        body: "Press the shortcut, speak, and what you say is typed once. Then it turns itself off.",
        segs: [
          { f: 8, t: "Off (not typed)", tSp: "Off", active: false },
          {
            f: 15,
            t: `${SHORTCUT} → types one utterance`,
            tSp: `${SHORTCUT} → once`,
            active: true,
          },
          { f: 17, t: "Turns off automatically", tSp: "Auto off", active: false },
        ],
        when: ["Places with people or conversations nearby", "Deciding for yourself when to type"],
        // アプリの動作 (docs/architecture.md の「操作」「入力モード」)。10 秒はアプリ側の固定値
        keys: [
          { when: "", does: "Starts listening for one utterance" },
          { when: "again before speaking", does: "Cancels listening" },
          { when: "while speaking", does: "Types right away, without waiting for silence" },
          { when: "then 10 seconds", does: "Turns off if you haven't started speaking" },
        ],
      },
    }),
    shortcut: {
      title: `Control it with ${SHORTCUT} from any app`,
      body: "Just press and release. No need to hold it down. You can change or disable the key in Settings. The panel button and the menu bar do the same thing.",
    },
  },

  features: {
    title: "Let your voice do the typing",
    items: list<Feature>([
      {
        no: "01",
        visual: "always",
        title: "Runs locally, so you can leave it on",
        body: "All speech recognition runs on your Mac. With no cloud fees or usage caps, you can keep it on from morning to night.",
      },
      {
        no: "02",
        visual: "vad",
        title: "Types only what you say, automatically",
        body: "mukuchi detects just the parts where you're speaking and transcribes them. A preview shows in the panel while you talk, and the text is typed at the cursor when you finish. Silence and background noise type nothing.",
      },
      {
        no: "03",
        visual: "command",
        title: "Key presses, by voice",
        body: "Say “enter,” “new line,” or “send” to trigger the matching key press. Commands run only when the whole utterance matches, so the same words inside a sentence are typed as usual. You can add, edit, or turn off phrases in Settings.",
      },
    ]),
    alwaysRows: list<AlwaysRow>([
      { icon: "wifi-off", k: "Network requests while transcribing", v: "0" },
      { icon: "infinity", k: "Daily usage limit", v: "None" },
      { icon: "user-round", k: "Account sign-up", v: "Not needed" },
    ]),
    vadLegend: { speech: "Speech (transcribed and typed)", silence: "Silence and noise (ignored)" },
    /** アプリの既定の音声コマンド (docs/architecture.md「言語」の en)。「new line」と「line break」は同じ ⇧ + Enter */
    commands: [
      { word: "enter", key: "Enter" },
      { word: "new line", key: "⇧ + Enter" },
      { word: "line break", key: "⇧ + Enter" },
      { word: "send", key: "⌘ + Enter" },
    ],
    quote: (w: string) => `“${w}”`,
    extrasTitle: "Built to stay out of your way",
    extras: list<IconItem>([
      {
        icon: "panel-top",
        title: "A panel that never steals focus",
        body: "Choose the standard view or a compact one with just the mic button. Drag it anywhere. It never takes focus from the app in front.",
      },
      {
        icon: "app-window",
        title: "Excluded apps",
        body: "Nothing is typed while an app on your list is in front.",
      },
      {
        icon: "book-a",
        title: "Recognition hints",
        body: "Describe your terms or topic in plain sentences. An instruction like “Spell it mukuchi, all lowercase” makes that spelling more likely.",
      },
    ]),
  },

  privacy: {
    title: "Your voice never leaves your Mac",
    lead: "All transcription happens on your device, so you can use it even when working with confidential documents or customer data.",
    items: list<IconItem>([
      {
        icon: "cpu",
        title: "On-device transcription",
        body: "Audio is never sent to an external server.",
      },
      { icon: "trash-2", title: "No recordings kept", body: "Audio is never saved." },
      {
        icon: "wifi-off",
        title: "Online only for models and updates",
        body: "It connects only to download speech recognition models and to check for and download updates. Automatic update checks can be turned off in Settings.",
      },
      {
        icon: "code-xml",
        title: "Open source",
        body: "You can review exactly how it works on GitHub.",
      },
    ]),
  },

  setup: {
    title: "Setup",
    lead: `No account needed. Setup takes about ${SETUP_MINUTES} minutes, including the model download.`,
    steps: list<Step>([
      {
        no: "1",
        title: "Download and install",
        body: `Open the dmg (about ${DMG_SIZE}) and move mukuchi to your Applications folder.`,
      },
      {
        no: "2",
        title: "Grant permissions",
        body: "Allow access to the microphone and Accessibility. Accessibility lets mukuchi type into other apps.",
      },
      {
        no: "3",
        title: "Download the speech model",
        // 話す言語 (英語・日本語) を選ぶと、その言語の推奨モデルを取得する (docs/architecture.md「言語」)
        body: `Choose the language you'll speak. For English, mukuchi downloads ${MODEL.name} (${MODEL_SIZE}); for Japanese, a version tuned for Japanese.`,
      },
      {
        no: "4",
        title: "Pick a mode and shortcut",
        body: `Choose “Always listen” or “Listen once,” and check the shortcut (${SHORTCUT} by default).`,
      },
      { no: "5", title: "Try it out", body: "Say something and check that it gets typed." },
    ]),
  },

  requirements: {
    title: "System requirements",
    lead: "Runs on Macs with Apple Silicon.",
    rows: [
      { k: "OS", v: "macOS 13 Ventura or later" },
      { k: "Chip", v: "Apple Silicon (M1 or later)" },
      { k: "Tested on", v: "M1 Max, M3 Pro" },
      { k: "Memory", v: "16 GB or more recommended" },
      { k: "Storage", v: "6 GB or more of free space" },
      // 表示言語と話す言語は別に選べる。英語のページを読む人が日本語を話す場合もあるため両方を書く
      { k: "Languages", v: "English and Japanese (choose the one you speak in Settings)" },
      { k: "Speech model", v: `${MODEL.name} (${MODEL_SIZE})` },
      { k: "Version", v: VERSION },
      { k: "Price", v: PRICE },
    ],
  },

  finalCta: {
    title: { lead: "Leave it on, ", rest: "and give it a day" },
    lead: `Free to use. About ${SETUP_MINUTES} minutes from install to your first dictation.`,
    leadMobile: "Free to use. Open this page in a browser on your Mac to download it.",
  },

  footer: {
    company: "Minimal, K.K.",
    analytics: "This site uses Google Analytics to measure traffic. ",
    analyticsLink: "How Google uses data",
  },

  demo: {
    tabsLabel: "Demo listening mode",
    status: {
      off: "Off",
      waiting: "Waiting",
      listening: "Listening",
      recognizing: "Recognizing",
      inserted: "Typed",
      key: "Key press",
    },
    modeMeta: {
      always: {
        appName: "AI Chat",
        note: "Default mode",
        label:
          "Example of mukuchi in action (Always listen). What you say is typed into an AI chat's input box, and saying “send” sends it.",
      },
      once: {
        appName: "Notes",
        note: `${SHORTCUT} types one utterance`,
        label: `Example of mukuchi in action (Listen once). Conversations around you aren't typed while it's off. After you press ${SHORTCUT}, one utterance is typed into Notes, and it turns itself off.`,
      },
    },
    scripts: {
      always: list<DemoStep>([
        {
          phase: "waiting",
          on: true,
          input: "",
          sent: [],
          caption: "While on, it waits for you to speak",
          ms: 1800,
        },
        {
          phase: "recognizing",
          on: true,
          speak: true,
          preview: "Please review the validation on the…",
          input: "",
          sent: [],
          caption: "A preview shows while you speak",
          ms: 1800,
        },
        {
          phase: "inserted",
          on: true,
          input: L1,
          sent: [],
          caption: "When you finish, it's typed at the cursor",
          ms: 1600,
        },
        {
          phase: "waiting",
          on: true,
          input: L1,
          sent: [],
          caption: "Nothing is typed while you're silent",
          ms: 1500,
        },
        {
          phase: "recognizing",
          on: true,
          speak: true,
          preview: "Also make the error messages…",
          input: L1,
          sent: [],
          caption: "Keep talking, and it keeps adding",
          ms: 1800,
        },
        {
          phase: "inserted",
          on: true,
          input: L1 + L2,
          sent: [],
          caption: "When you finish, it's typed at the cursor",
          ms: 1400,
        },
        {
          phase: "recognizing",
          on: true,
          speak: true,
          preview: "send",
          input: L1 + L2,
          sent: [],
          caption: "",
          ms: 1000,
        },
        {
          phase: "key",
          on: true,
          chip: "“send” → ⌘ + Enter",
          input: "",
          sent: [L1 + L2],
          caption: "Set phrases run as key presses",
          ms: 2600,
        },
      ]),
      once: list<DemoStep>([
        {
          phase: "off",
          noise: true,
          input: "",
          sent: [],
          caption: "While off, nearby conversations aren't typed",
          ms: 2000,
        },
        {
          phase: "off",
          chip: SHORTCUT,
          input: "",
          sent: [],
          caption: "Press the shortcut to listen for one utterance",
          ms: 1300,
        },
        {
          phase: "listening",
          on: true,
          input: "",
          sent: [],
          caption: "Waiting for you to start speaking",
          ms: 1200,
        },
        {
          phase: "recognizing",
          on: true,
          speak: true,
          preview: "Next week's team meeting moves to…",
          input: "",
          sent: [],
          caption: "A preview shows while you speak",
          ms: 1900,
        },
        {
          phase: "inserted",
          input: M1,
          sent: [],
          caption: "When you finish, it's typed and turns off",
          ms: 1800,
        },
        {
          phase: "off",
          noise: true,
          input: M1,
          sent: [],
          caption: "Nothing is typed until you press it again",
          ms: 2000,
        },
      ]),
    },
  },
} satisfies Messages;

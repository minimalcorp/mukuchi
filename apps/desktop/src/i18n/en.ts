/*
 * 英語の辞書。キーと引数は ja.ts (Messages) と同じでなければ型検査で落ちる。
 * 用語は macOS (Apple HIG) に合わせる: ボタン・メニュー項目は Title Case、説明文は文の形
 */
import type { ReactNode } from "react";
import type { Messages } from "./ja";
import { rich } from "./rich";

const plural = new Intl.PluralRules("en");
const minutes = (n: number) => (plural.select(n) === "one" ? "minute" : "minutes");
const items = (n: number) => (plural.select(n) === "one" ? "item" : "items");

export const en = {
  languageName: { ja: "Japanese", en: "English" },

  common: {
    openSystemSettings: "Open System Settings",
    cancel: "Cancel",
    close: "Close",
    delete: "Delete",
    save: "Save",
    next: "Continue",
    back: "Back",
    skip: "Skip",
    allow: "Allow",
    granted: "Allowed",
    notGranted: "Not Allowed",
    checking: "Checking…",
    help: "Help",
    restart: "Restart",
    openSetup: "Open Setup",
    pause: "Pause",
    resume: "Resume",
    retry: "Try Again",
    download: "Download",
    separator: " · ",
  },

  format: {
    etaUnderMinute: "Less than a minute left",
    etaMinutes: (n: number) => `About ${n} ${minutes(n)} left`,
    today: (time: string) => `Today at ${time}`,
    dateTime: (date: string, time: string) => `${date} at ${time}`,
    seconds: (value: string) => `${value} sec`,
  },

  errorActions: {
    open_accessibility: "Open System Settings",
    open_microphone: "Open System Settings",
    select_microphone: "Choose Microphone",
    restart_asr: "Restart",
    start_setup: "Open Setup",
  },

  inputMode: {
    groupLabel: "Input mode",
    continuous: {
      label: "Always listen",
      description: "While on, transcribes everything you say",
      useCases: ["When you’re working alone", "When you want to keep dictating hands-free"],
    },
    oneShot: {
      label: "Listen once",
      description: "Transcribes one utterance after you press the shortcut, then turns off",
      useCases: ["When other people are around or talking nearby", "When you want to choose when to type"],
    },
    shortcutHint: {
      continuous: "Turns voice input on or off each time you press it",
      oneShot: "Listens once when pressed, and turns off automatically when you finish speaking",
    },
  },

  shortcut: {
    label: "Shortcut",
    help: "Works in any app. It may not work if another app uses the same keys",
    recordingGuide: "Press a key together with ⌃, ⌥, ⇧, or ⌘. Press esc to cancel, or ⌫ to remove the shortcut",
    unsupportedGuide: "This key can’t be used for a shortcut. Press a different key, or esc to cancel",
    pressKeys: "Press keys",
    none: "None",
    change: "Change",
    clear: "Remove Shortcut",
  },

  panel: {
    turnOn: "Turn On Voice Input",
    turnOff: "Turn Off Voice Input",
    loadingModel: "Loading model…",
    loadingModelShort: "Loading model",
    errors: {
      accessibility_denied: "Accessibility access needed",
      microphone_denied: "Microphone access needed",
      asr_stopped: "Transcription stopped",
      microphone_missing: "No microphone found",
      runtime_missing: "Model not installed",
      insert_failed: "Couldn’t type text",
      vad_failed: "Couldn’t start speech detection",
    },
    idle: "Listening",
    speaking: "Hearing you",
    finalizing: "Finishing…",
    inserted: "Typed",
    command: "Voice command",
    excluded: (app: string) => `Not typing in ${app}`,
    commandSent: (key: ReactNode): ReactNode => rich("Sent ", key),
  },

  setup: {
    windowTitle: "mukuchi Setup",
    progress: (step: number, total: number) => `Step ${step} of ${total}`,
    welcome: {
      title: "Welcome to mukuchi",
      lead: "mukuchi lets you type just by speaking. Finish a few steps to get started.",
      privacy: "Transcription happens on this Mac. Your voice never leaves it",
      download: "Downloads the runtime and the speech model",
      downloadWithSize: (size: string) => `Downloads the runtime and the speech model (about ${size})`,
      duration: "Takes about 5–10 minutes",
      uiLanguage: "App language",
      speechLanguage: "Language you speak",
      speechLanguageHelp:
        "The language to transcribe. The model to download is chosen for this language. You can change it later in Settings > Recognition",
      speechLanguageLocked: "The download has started. Change this in Settings > Recognition after setup.",
      speechLanguageLockedRunning: "Can’t change while setup is running. Change this in Settings > Recognition after setup.",
      start: "Get Started",
    },
    permissions: {
      title: "Allow access",
      lead: "Allow both to continue.",
      microphone: "Microphone",
      microphoneSub: "Used to hear what you say",
      accessibility: "Accessibility",
      accessibilityHelp: "Needed to send text and keystrokes to the cursor in other apps",
      accessibilitySub: "Used to type text",
      guideMicNotDetermined: "Allow mukuchi to use the microphone. A confirmation dialog will appear.",
      guideMicDenied: "Turn on mukuchi in System Settings > Microphone. This updates automatically once allowed.",
      guideAccessibility: "Turn on mukuchi in System Settings. This updates automatically once allowed.",
    },
    download: {
      titlePending: "Download the runtime and model",
      checkingStatus: "Checking status…",
      titleDone: "The runtime and model are ready",
      titlePaused: "Download paused",
      titleFailed: "Setup couldn’t be completed",
      titleRunning: "Downloading the runtime and model",
      overall: "Overall",
      overallProgress: "Overall progress",
      runtime: "Python runtime",
      modelFallback: "Speech model",
      verify: "Verification",
      runningRuntime: "Preparing…",
      runningModel: "Getting file list…",
      runningVerify: "Checking…",
      preparingRuntime: "Preparing the runtime",
      etaCalculating: "Calculating time left",
      verifying: "Checking that it works",
      paused: "Paused",
      pending: "Waiting",
      done: "Done",
      failed: "Failed",
      failedFallback: "Setup failed.",
      resumeFrom: (size: string) => ` Resumes from the ${size} already downloaded.`,
    },
    inputMode: {
      title: "Choose how to dictate",
      useCases: "Good for",
    },
    test: {
      title: "Try speaking",
      oneShotWithKeys: (keys: ReactNode, sample: string): ReactNode =>
        rich("The panel is now at the bottom of the screen. Press ", keys, ` and say something like “${sample}”. Voice input turns off when you finish speaking.`),
      oneShotNoKeys: (sample: string) =>
        `The panel is now at the bottom of the screen. Turn on voice input in the panel and say something like “${sample}”. Voice input turns off when you finish speaking.`,
      continuousWithKeys: (keys: ReactNode, sample: string): ReactNode =>
        rich("The panel is now at the bottom of the screen. Turn on voice input in the panel or with ", keys, ` and say something like “${sample}”.`),
      continuousNoKeys: (sample: string) =>
        `The panel is now at the bottom of the screen. Turn on voice input in the panel and say something like “${sample}”.`,
      inputLevel: "Input level",
      field: "Test field",
      sentKey: (key: string) => `Sent ${key}`,
      recognized: "Recognized successfully.",
    },
    done: {
      title: "You’re all set",
      lead: "mukuchi stays in the menu bar. Open settings from the menu bar icon.",
      hintOneShot: (keys: ReactNode): ReactNode =>
        rich("Press ", keys, " to listen once. You can also start from the panel or the menu bar icon"),
      hintWithKeys: (keys: ReactNode): ReactNode =>
        rich("Turn voice input on or off from the panel, the menu bar icon, or ", keys),
      hintNoKeys: "Turn voice input on or off from the panel or the menu bar icon",
      launchAtLogin: "Open at Login",
    },
  },

  settings: {
    categories: {
      general: "General",
      voice: "Voice Input",
      commands: "Voice Commands",
      recognition: "Recognition",
      permissions: "Permissions",
      storage: "Storage",
      about: "About",
    },
    permissionsWarning: "Some permissions aren’t allowed",

    general: {
      language: "Language",
      uiLanguage: "App language",
      uiLanguageSub: "Set the language you speak in Recognition",
      system: "System Default",
      behavior: "Behavior",
      launchAtLogin: "Open at Login",
      panel: "Panel",
      compact: "Compact panel",
      compactSub: "Shows only the microphone button in the voice input panel. You can also switch from the panel’s context menu",
    },

    voice: {
      inputModeHelp: "Where other people are around or talking nearby, Listen once avoids typing voices you didn’t mean to",
      microphone: "Microphone",
      systemDefault: "System Default",
      systemDefaultWith: (name: string) => `System Default (${name})`,
      disconnected: "Selected microphone (not connected)",
      inputLevel: "Input level",
      sensitivity: "Speech detection sensitivity",
      sensitivityHelp:
        "Higher picks up quieter voices. Lower it in noisy places. The point where the track turns light blue is the detection threshold",
      low: "Low",
      high: "High",
      silence: "Silence before end of speech",
      silenceHelp: "Shorter types sooner, but pauses for breath may split sentences",
      excludedApps: "Don’t type in these apps",
      excludedAppsHelp:
        "Add apps where you want to avoid typing by mistake, such as password managers or Terminal. While one is in front, mukuchi doesn’t type and the panel says so",
      removeApp: (name: string) => `Remove ${name}`,
      noApps: "No apps added",
      addApp: "Add App",
      runningApps: "Open apps",
      loadingApps: "Loading…",
      noCandidates: "No apps to add",
    },

    commands: {
      enable: "Use voice commands",
      enableSub: "Sends a keystroke only when everything you say matches a phrase.",
      phrases: "Phrases",
      key: "Key",
      edit: "Edit",
      delete: "Delete",
      add: "Add Command",
      note: (example: string) => `If you say other words with it, like “${example}”, it’s typed as regular text.`,
      addTitle: "Add Command",
      editTitle: "Edit Command",
      dialogDescription: "Separate multiple phrases with commas.",
      phraseJoiner: ", ",
      modifiers: "Modifier keys",
      keyName: "Key",
      keyPreview: "Sends:",
      validation: {
        empty: "Enter a phrase",
        symbolsOnly: (p: string) => `“${p}” can’t be used because it contains only symbols or spaces`,
        duplicate: (p: string) => `“${p}” appears more than once`,
        equivalent: (a: string, b: string) => `“${a}” and “${b}” count as the same phrase`,
        conflict: (p: string, key: string, hit: string) => `“${p}” conflicts with “${hit}” in another command (${key})`,
      },
    },

    recognition: {
      checking: "Checking",
      loading: "Loading",
      loadingSub: "Loading the model",
      stopped: "Stopped",
      stoppedSub: "The transcription server has stopped",
      missing: "Not Installed",
      missingSub: "The runtime and model aren’t installed",
      loaded: "Loaded",
      loadedSub: "Running on the Apple silicon GPU",
      speechLanguage: "Language you speak",
      speechLanguageHelp:
        "The language to transcribe. The recommended model and the default voice command phrases (if you haven’t changed them) follow this language",
      context: "Recognition hints",
      contextHelp:
        "Passed as-is to the transcription model. Describe the topic or how to spell terms (with how they sound) to have them recognized that way. Longer hints make recognition slower",
      contextPlaceholder: "e.g. This is about software development. Spell these terms as written: Claude Code, pnpm, Tauri",
      contextOver: (max: number, over: number) => `More than ${max} characters (${over} over)`,
    },

    models: {
      heading: "Model",
      help: "The model used for transcription. Switching reloads the model, and voice input is off while it loads",
      setupIncomplete: "You can’t switch or download models until setup is complete.",
      recommended: "Recommended",
      tunedFor: (language: string) => `Tuned for ${language}`,
      inUse: "In Use",
      switching: "Switching…",
      use: "Use",
      downloadingElsewhere: "Another model is downloading. Only one model can download at a time",
      inUseCantDelete: "The model in use can’t be deleted. Switch to another model first",
      downloaded: "Downloaded",
      notDownloaded: "Not downloaded",
      paused: "Paused",
      failed: "Failed",
      etaCalculating: "Calculating time left",
      progress: (name: string) => `Downloading ${name}`,
      cancel: "Cancel",
      deleteTitle: "Delete this model?",
      deleteDescription: (name: string, size: string) =>
        `“${name}” (${size}) will be deleted. You’ll need to download it again to use it.`,
      recommendation: (language: string, name: string) => `“${name}” is recommended for ${language}`,
      recommendationDownloading: "You can switch once the download finishes",
      switchTo: "Switch",
    },

    permissions: {
      microphone: "Microphone",
      microphoneSub: "Used to hear what you say",
      accessibility: "Accessibility",
      accessibilitySub: "Used to type text and send keystrokes",
      micNotDetermined: "Microphone access hasn’t been allowed yet. Allow it to use voice input.",
      micDenied:
        "mukuchi can’t hear you without access. Turn on mukuchi in System Settings > Privacy & Security > Microphone.",
      accessibilityDenied:
        "mukuchi can transcribe but can’t type without access. Turn on mukuchi in System Settings > Privacy & Security > Accessibility.",
    },

    storage: {
      runtime: "Python runtime",
      models: "Models",
      other: "Settings and logs",
      used: "used",
      runtimeMissing: "The runtime and model aren’t installed. To use voice input, download them again in Setup.",
      deleteRuntime: "Delete Runtime and Models Only",
      deleteRuntimeSub: "Your settings are kept. You’ll need to run setup again to use mukuchi.",
      uninstall: "Uninstall Completely",
      uninstallSub: "Deletes all data and the app itself.",
      uninstallEllipsis: "Uninstall…",
      deleteRuntimeTitle: "Delete the runtime and models?",
      deleteRuntimeDescription:
        "Voice input will stop working. Settings and logs are kept. To use it again, download them in Setup.",
      uninstallTitle: "Uninstall mukuchi completely?",
      uninstallDone: "Uninstalled. mukuchi will quit.",
      uninstallRunning: "Uninstalling… mukuchi will quit when finished.",
      uninstallConfirm: "The following will be deleted. You can’t undo this action.",
      uninstallButton: "Uninstall",
      uninstallCount: (count: number) =>
        `${count} ${items(count)} (also removes the login item and permissions)`,
      uninstallTotal: (size: string) => `Total ${size}`,
    },

    about: {
      version: (version: string, build: string) => `Version ${version} (build ${build})`,
      license: "License",
      show: "Show",
      logs: "Logs",
      openInFinder: "Show in Finder",
      updates: "Updates",
      install: "Restart to Update",
      check: "Check for Updates",
      autoCheck: "Check for updates automatically",
      autoCheckSub: "Checks at launch and every 6 hours, and downloads new versions in the background",
      unavailable: "Automatic updates aren’t available",
      upToDate: "mukuchi is up to date",
      lastChecked: (when: string) => `Last checked ${when}`,
      notChecked: "Not checked yet",
      current: (version: string) => `Current version ${version}`,
      checking: "Checking for updates…",
      downloading: (version: string | null) => (version ? `Downloading ${version}` : "Downloading update"),
      downloadProgress: "Update download",
      ready: (version: string | null) => (version ? `${version} is ready to install` : "An update is ready to install"),
      readySub: (current: string) => `Restart to update (current version ${current})`,
      installing: (version: string | null) => (version ? `Installing ${version}…` : "Installing update…"),
      installingSub: "mukuchi will restart automatically when finished",
      failed: (version: string | null) =>
        version ? `Couldn’t update to ${version}` : "Couldn’t check for updates",
    },
  },
} satisfies Messages;

import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "Parse",
  slug: "parse-companion",
  version: "0.1.0",
  scheme: "parse-companion",
  platforms: ["ios", "android"],
  orientation: "portrait",
  userInterfaceStyle: "light",
  ios: {
    bundleIdentifier: "sg.parse.companion",
    supportsTablet: false,
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  android: { package: "sg.parse.companion", allowBackup: false },
  plugins: [
    [
      "expo-audio",
      {
        microphonePermission:
          "Parse records only when you choose to speak, so it can read back and confirm your care updates.",
        enableBackgroundRecording: false,
        enableBackgroundPlayback: false,
      },
    ],
    ["expo-secure-store", { configureAndroidBackup: true }],
    ["expo-notifications", { color: "#A24F3D" }],
  ],
};
export default config;

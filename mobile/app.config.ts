import type { ExpoConfig } from "expo/config";

const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
if (projectId && !/^[a-f0-9-]{36}$/i.test(projectId))
  throw new Error("EXPO_PUBLIC_EAS_PROJECT_ID must be an Expo project UUID");
const config: ExpoConfig = {
  name: "Parse",
  slug: "parse-companion",
  version: "0.1.0",
  scheme: "parse-companion",
  ...(projectId ? { extra: { eas: { projectId } } } : {}),
  platforms: ["ios", "android"],
  orientation: "portrait",
  userInterfaceStyle: "light",
  ios: {
    bundleIdentifier: "sg.parse.companion",
    supportsTablet: false,
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  android: {
    package: "sg.parse.companion",
    allowBackup: false,
    ...(process.env.PARSE_GOOGLE_SERVICES_FILE
      ? { googleServicesFile: process.env.PARSE_GOOGLE_SERVICES_FILE }
      : {}),
  },
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

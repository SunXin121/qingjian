import baseManifest from "./manifest.base.json";

export type ExtensionTarget = "chromium" | "firefox";

export const FIREFOX_ADDON_ID = "web-clipper@edgeever.org";
export const FIREFOX_MIN_VERSION = "140.0";
export const FIREFOX_ANDROID_MIN_VERSION = "142.0";

export const buildExtensionManifest = (target: ExtensionTarget, version: string) => {
  const background = target === "firefox"
    ? {
        scripts: ["assets/background.js"],
        type: "module",
      }
    : {
        service_worker: "assets/background.js",
        type: "module",
      };

  return {
    ...baseManifest,
    version,
    background,
    ...(target === "firefox"
      ? {
          browser_specific_settings: {
            gecko: {
              id: FIREFOX_ADDON_ID,
              strict_min_version: FIREFOX_MIN_VERSION,
              data_collection_permissions: {
                required: [
                  "authenticationInfo",
                  "browsingActivity",
                  "websiteContent",
                ],
              },
            },
            gecko_android: {
              strict_min_version: FIREFOX_ANDROID_MIN_VERSION,
            },
          },
        }
      : {}),
  };
};

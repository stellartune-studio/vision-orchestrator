import { installManagedEnvironment } from "../server/src/environment/managedInstaller.ts";
import { planEnvironment } from "../server/src/environment/setupService.ts";
const result = await installManagedEnvironment({
  plan: planEnvironment("managed"), allowDownloads: process.argv.includes("--allow-downloads"), startServices: process.argv.includes("--start"),
  assertAllowed() {}, connect() { return false; },
});
console.log(JSON.stringify(result, null, 2));

import { planEnvironment } from "../server/src/environment/setupService.ts";
process.stdout.write(JSON.stringify(planEnvironment(process.argv[2] ?? "managed"), null, 2));

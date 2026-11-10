import { hashPassword } from "../backend/security.ts";
// Read stdin rather than a command-line argument (which is visible in process lists).
let input = "";
for await (const chunk of process.stdin) input += chunk;
console.log(await hashPassword(input.trimEnd()));

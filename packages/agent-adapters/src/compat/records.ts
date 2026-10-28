// 由 test/conformance/records.mjs 从 compat/*.json 生成，不要手改。
// 改了 compat/*.json 之后：pnpm --filter @agentdeck/agent-adapters conformance --records

import type { CompatRecord } from './types.ts';

export const COMPAT_RECORDS: Readonly<Record<string, CompatRecord>> = {
  "claude": {
    "agent": "claude",
    "version": "2.1.291",
    "date": "2026-10-28",
    "verifiedUpTo": "2.1.291",
    "results": {
      "K1": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "2.1.291"
      },
      "K2": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "2.1.291"
      },
      "K3": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "2.1.291"
      },
      "K4": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "2.1.291"
      },
      "K5": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "2.1.291"
      },
      "K6": {
        "result": "pass",
        "suite": "manual",
        "reason": "Checked by hand on 2.1.291: the PermissionRequest hook answers allow (PL1); L2 does not approve because it would change files",
        "verifiedUpTo": "2.1.291"
      },
      "K7": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "2.1.291"
      },
      "K8": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "2.1.291"
      },
      "K9": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "2.1.291"
      },
      "K10": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "2.1.291"
      },
      "K11": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "2.1.291"
      },
      "K12": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "2.1.291"
      },
      "K13": {
        "result": "skip",
        "suite": "L2",
        "reason": "Not read for Claude Code yet",
        "verifiedUpTo": null
      },
      "K14": {
        "result": "pass",
        "suite": "manual",
        "reason": "Checked by hand on 2.1.291 (M1): --mcp-config with the agentdeck http server, tools listed and called",
        "verifiedUpTo": "2.1.291"
      },
      "K15": {
        "result": "pass",
        "suite": "manual",
        "reason": "Checked by hand on 2.1.291 (N9): claude --plugin-dir <set> plugin details agentdeck-skills lists the skills",
        "verifiedUpTo": "2.1.291"
      },
      "K16": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "2.1.291"
      },
      "K17": {
        "result": "skip",
        "suite": "L2",
        "reason": "Can't make a real agent reject an option on purpose; L1 covers it with a fake program",
        "verifiedUpTo": null
      },
      "K18": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "2.1.291"
      }
    }
  },
  "codex": {
    "agent": "codex",
    "version": "0.165.0",
    "date": "2026-10-28",
    "verifiedUpTo": "0.165.0",
    "results": {
      "K1": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "0.165.0"
      },
      "K2": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "0.165.0"
      },
      "K3": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "0.165.0"
      },
      "K4": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "0.165.0"
      },
      "K5": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "0.165.0"
      },
      "K6": {
        "result": "pass",
        "suite": "manual",
        "reason": "Checked by hand on 0.159.2: the PermissionRequest hook answers allow (PL1); L2 does not approve because it would change files",
        "verifiedUpTo": "0.159.2"
      },
      "K7": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "0.165.0"
      },
      "K8": {
        "result": "skip",
        "suite": "L2",
        "reason": "Codex has no question tool yet",
        "verifiedUpTo": null
      },
      "K9": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "0.165.0"
      },
      "K10": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "0.165.0"
      },
      "K11": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "0.165.0"
      },
      "K12": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "0.165.0"
      },
      "K13": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "0.165.0"
      },
      "K14": {
        "result": "pass",
        "suite": "manual",
        "reason": "Checked on 0.164.0: packages/mcp-server real-codex lists the tools and calls list_workspaces through -c mcp_servers.agentdeck",
        "verifiedUpTo": "0.164.0"
      },
      "K15": {
        "result": "skip",
        "suite": "L2",
        "reason": "Not supported for codex",
        "verifiedUpTo": null
      },
      "K16": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "0.165.0"
      },
      "K17": {
        "result": "skip",
        "suite": "L2",
        "reason": "Can't make a real agent reject an option on purpose; L1 covers it with a fake program",
        "verifiedUpTo": null
      },
      "K18": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "0.165.0"
      }
    }
  },
  "kimi": {
    "agent": "kimi",
    "version": "2.3.3",
    "date": "2026-10-28",
    "verifiedUpTo": "2.3.3",
    "results": {
      "K1": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "2.3.3"
      },
      "K2": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "2.3.3"
      },
      "K3": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "2.3.3"
      },
      "K4": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "2.3.3"
      },
      "K5": {
        "result": "skip",
        "suite": "L2",
        "reason": "Waiting is not detected for Kimi",
        "verifiedUpTo": null
      },
      "K6": {
        "result": "skip",
        "suite": "L2",
        "reason": "Not supported for kimi yet",
        "verifiedUpTo": null
      },
      "K7": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "2.3.3"
      },
      "K8": {
        "result": "skip",
        "suite": "L2",
        "reason": "Waiting is not detected for Kimi",
        "verifiedUpTo": null
      },
      "K9": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "2.3.3"
      },
      "K10": {
        "result": "skip",
        "suite": "L2",
        "reason": "Kimi can't fork conversations",
        "verifiedUpTo": null
      },
      "K11": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "2.3.3"
      },
      "K12": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "2.3.3"
      },
      "K13": {
        "result": "skip",
        "suite": "L2",
        "reason": "Not read for Kimi yet",
        "verifiedUpTo": null
      },
      "K14": {
        "result": "skip",
        "suite": "L2",
        "reason": "No AgentDeck MCP yet",
        "verifiedUpTo": null
      },
      "K15": {
        "result": "skip",
        "suite": "L2",
        "reason": "Not checked in Kimi yet (only --help and the bundled source)",
        "verifiedUpTo": null
      },
      "K16": {
        "result": "skip",
        "suite": "L2",
        "reason": "No hooks to lose: status already comes from terminal activity",
        "verifiedUpTo": null
      },
      "K17": {
        "result": "skip",
        "suite": "L2",
        "reason": "Can't make a real agent reject an option on purpose; L1 covers it with a fake program",
        "verifiedUpTo": null
      },
      "K18": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "2.3.3"
      }
    }
  },
  "omp": {
    "agent": "omp",
    "version": "18.0.4",
    "date": "2026-10-28",
    "verifiedUpTo": "18.0.4",
    "results": {
      "K1": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "18.0.4"
      },
      "K2": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "18.0.4"
      },
      "K3": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "18.0.4"
      },
      "K4": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "18.0.4"
      },
      "K5": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "18.0.4"
      },
      "K6": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "18.0.4"
      },
      "K7": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "18.0.4"
      },
      "K8": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "18.0.4"
      },
      "K9": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "18.0.4"
      },
      "K10": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "18.0.4"
      },
      "K11": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "18.0.4"
      },
      "K12": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "18.0.4"
      },
      "K13": {
        "result": "skip",
        "suite": "L2",
        "reason": "Not read for Oh My Pi yet",
        "verifiedUpTo": null
      },
      "K14": {
        "result": "skip",
        "suite": "L2",
        "reason": "Only the config parsing was checked on 18.0.4 (N1), not in the terminal",
        "verifiedUpTo": null
      },
      "K15": {
        "result": "pass",
        "suite": "manual",
        "reason": "Checked on 18.0.4 (N9) with omp's own loader (injectPluginDirRoots + loadCapability('skills')), not in the TUI",
        "verifiedUpTo": "18.0.4"
      },
      "K16": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "18.0.4"
      },
      "K17": {
        "result": "skip",
        "suite": "L2",
        "reason": "Can't make a real agent reject an option on purpose; L1 covers it with a fake program",
        "verifiedUpTo": null
      },
      "K18": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "18.0.4"
      }
    }
  },
  "pi": {
    "agent": "pi",
    "version": "0.83.0",
    "date": "2026-10-28",
    "verifiedUpTo": "0.83.0",
    "results": {
      "K1": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "0.83.0"
      },
      "K2": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "0.83.0"
      },
      "K3": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "0.83.0"
      },
      "K4": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "0.83.0"
      },
      "K5": {
        "result": "skip",
        "suite": "L2",
        "reason": "Pi never asks for approval",
        "verifiedUpTo": null
      },
      "K6": {
        "result": "skip",
        "suite": "L2",
        "reason": "Pi never asks for approval",
        "verifiedUpTo": null
      },
      "K7": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "0.83.0"
      },
      "K8": {
        "result": "skip",
        "suite": "L2",
        "reason": "Pi has no question tool",
        "verifiedUpTo": null
      },
      "K9": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "0.83.0"
      },
      "K10": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "0.83.0"
      },
      "K11": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "0.83.0"
      },
      "K12": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "0.83.0"
      },
      "K13": {
        "result": "skip",
        "suite": "L2",
        "reason": "Not read for Pi yet",
        "verifiedUpTo": null
      },
      "K14": {
        "result": "skip",
        "suite": "L2",
        "reason": "Pi has no MCP",
        "verifiedUpTo": null
      },
      "K15": {
        "result": "pass",
        "suite": "manual",
        "reason": "Checked by hand on 0.83.0 (N9): pi --mode rpc --skill <folder> get_commands lists skill:<name>",
        "verifiedUpTo": "0.83.0"
      },
      "K16": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "0.83.0"
      },
      "K17": {
        "result": "skip",
        "suite": "L2",
        "reason": "Can't make a real agent reject an option on purpose; L1 covers it with a fake program",
        "verifiedUpTo": null
      },
      "K18": {
        "result": "pass",
        "suite": "L2",
        "verifiedUpTo": "0.83.0"
      }
    }
  },
};

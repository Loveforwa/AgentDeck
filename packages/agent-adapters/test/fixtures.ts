// 本机实测抓到的钩子负载（claude 2.1.291、codex 0.159.2），去掉了路径和无关字段。

export const claude = {
  SessionStart: {
    session_id: 'c2874ef2-d753-4246-a52b-c4eec2e93598',
    hook_event_name: 'SessionStart',
    source: 'startup',
    model: 'claude-opus-5-5',
  },
  UserPromptSubmit: {
    session_id: 'c2874ef2-d753-4246-a52b-c4eec2e93598',
    permission_mode: 'default',
    hook_event_name: 'UserPromptSubmit',
    prompt: 'reply with OK',
  },
  PermissionRequestBash: {
    permission_mode: 'default',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'mkdir agentdeck-probe', description: 'Create probe directory' },
    permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
  },
  PermissionRequestAsk: {
    hook_event_name: 'PermissionRequest',
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [
        {
          question: 'Do you prefer tea or coffee?',
          header: 'Drink',
          options: [
            { label: 'Tea', description: 'You prefer tea.' },
            { label: 'Coffee', description: 'You prefer coffee.' },
          ],
          multiSelect: false,
        },
      ],
    },
  },
  PostToolUseAsk: {
    hook_event_name: 'PostToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [{ question: 'Do you prefer tea or coffee?', header: 'Drink', options: [], multiSelect: false }],
    },
    tool_response: { answers: { 'Do you prefer tea or coffee?': 'Tea' } },
  },
  NotificationPermission: {
    hook_event_name: 'Notification',
    message: 'Claude needs your permission',
    notification_type: 'permission_prompt',
  },
  Stop: { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'OK' },
  SessionEnd: { hook_event_name: 'SessionEnd', reason: 'other' },
};

export const codex = {
  SessionStart: {
    session_id: '01a168da-2729-7752-adf2-dd274b58dd05',
    hook_event_name: 'SessionStart',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    source: 'startup',
  },
  PermissionRequest: {
    hook_event_name: 'PermissionRequest',
    model: 'gpt-6.1-sol',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: {
      command: 'mkdir agentdeck-probe',
      description: 'Allow creating the agentdeck-probe directory outside the read-only sandbox?',
    },
  },
  Interrupt: { hook_event_name: 'Interrupt', model: 'gpt-6.1-sol', permission_mode: 'default' },
  Stop: { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'OK' },
  /** hooks/list 的结果（app-server）。 */
  hooksList: (commands: string[]) => ({
    data: [
      {
        cwd: '/repo',
        hooks: [
          ...commands.map((command, i) => ({
            key: `/<session-flags>/config.toml:event${i}:0:0`,
            eventName: `event${i}`,
            command,
            currentHash: `sha256:${i}`,
            source: 'sessionFlags',
            trustStatus: 'untrusted',
          })),
          { key: '/repo/.codex/hooks.json:stop:0:0', command: 'echo project', currentHash: 'sha256:p', source: 'project' },
        ],
      },
    ],
  }),
};

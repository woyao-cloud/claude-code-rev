// Re-export message creation functions from utils/messages.ts
// This file serves as the public API for the prompt/messages module

export {
  createUserMessage,
  createAssistantMessage,
  createAssistantAPIErrorMessage,
  createUserInterruptionMessage,
  createSyntheticUserCaveatMessage,
  createProgressMessage,
  createToolResultStopMessage,
  createSystemMessage,
  createPermissionRetryMessage,
  createBridgeStatusMessage,
  createScheduledTaskFireMessage,
  createStopHookSummaryMessage,
  createTurnDurationMessage,
  createAwaySummaryMessage,
  createMemorySavedMessage,
  createAgentsKilledMessage,
  createApiMetricsMessage,
  createCommandInputMessage,
  createCompactBoundaryMessage,
  createMicrocompactBoundaryMessage,
  createSystemAPIErrorMessage,
  createToolUseSummaryMessage,
  createModelSwitchBreadcrumbs,
  formatCommandInputTags,
} from '../../utils/messages.js'

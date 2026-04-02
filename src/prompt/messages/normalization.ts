// Re-export message normalization functions from utils/messages.ts
// This file serves as the public API for the prompt/messages module

export {
  normalizeMessages,
  normalizeMessagesForAPI,
  normalizeContentFromAPI,
  normalizeAttachmentForAPI,
  prepareUserContent,
} from '../../utils/messages.js'

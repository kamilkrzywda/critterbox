/**
 * Species barrel — importing this module registers every species into the registry as a side effect
 * (Sandfall self-registration pattern). Both the sim and seedLife import it so the registry is always
 * populated before any agent is created or stepped. Add animal barrels here in Phase 4.
 */

import './plants/grass';
import './plants/clover';
import './plants/cranberry';
import './plants/reed';
import './plants/tree';

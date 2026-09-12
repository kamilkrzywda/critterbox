/**
 * Species barrel — importing this module registers every species into the registry as a side effect
 * (Sandfall self-registration pattern). Both the sim and seedLife import it so the registry is always
 * populated before any agent is created or stepped. New animal species modules are added here too.
 */

import './plants/grass';
import './plants/clover';
import './plants/cranberry';
import './plants/reed';
import './plants/tree';
import './animals/mouse';
import './animals/hare';
import './animals/hamster';
import './animals/deer';
import './animals/insect';
// Phase 5: frogs + the predator/scavenger layer (fox/stork/owl/crow)
import './animals/frog';
import './animals/fox';
import './animals/stork';
import './animals/owl';
import './animals/crow';

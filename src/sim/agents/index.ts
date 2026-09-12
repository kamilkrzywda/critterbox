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
import './animals/mysz';
import './animals/zajac';
import './animals/chomik';
import './animals/sarna';
import './animals/owady';

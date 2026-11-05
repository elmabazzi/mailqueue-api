// Loads .env (if present) so tests can read TEST_DATABASE_URL locally.
// Variables already set in the shell win over the file.
import { config } from 'dotenv';

config({ quiet: true });

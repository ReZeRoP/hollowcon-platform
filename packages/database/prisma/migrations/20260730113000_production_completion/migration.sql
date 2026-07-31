-- PostgreSQL requires newly added enum values to be committed before they are used.
-- Keep this enum extension in its own migration so the following migration can safely
-- backfill provisioning jobs to the truthful `provisioned` state.
ALTER TYPE "ProvisioningStatus" ADD VALUE IF NOT EXISTS 'provisioned' BEFORE 'delivered';

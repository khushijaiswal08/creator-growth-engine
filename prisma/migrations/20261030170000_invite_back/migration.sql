-- The Invite back list: a proven creator a person invited to a new campaign, and the welcome-back first message.
ALTER TYPE "TemplatePurpose" ADD VALUE 'welcome_back';

ALTER TABLE "CampaignCreator" ADD COLUMN "invitedBackAt" TIMESTAMP(3);

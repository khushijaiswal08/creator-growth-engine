-- The first message to a creator invited back. In its own migration because a new enum value
-- ('welcome_back') cannot be used in the transaction that adds it. Kept if it already exists.
INSERT INTO "Template" ("id", "name", "purpose", "body", "archived", "createdAt", "updatedAt")
VALUES (
  'template_welcome_back',
  'Welcome back',
  'welcome_back',
  E'Hi {name}!\n\nIt''s {sender} from {brand}. We loved the content you made with us last time, and we have new pieces we think you would enjoy. Would you like to choose another one as a gift? As before, there is no obligation to post.\n\n{sender}',
  false,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("name") DO NOTHING;

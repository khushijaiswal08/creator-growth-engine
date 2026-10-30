-- The template that sends a creator their content-upload link. In its own migration because a
-- new enum value ('upload') cannot be used in the transaction that adds it. Kept if it already exists.
INSERT INTO "Template" ("id", "name", "purpose", "body", "archived", "createdAt", "updatedAt")
VALUES (
  'template_send_your_files',
  'Send your files',
  'upload',
  E'Hi {name}! Thank you so much for creating with our {product}. Could you send us the original video and photos, in full quality rather than the version from Instagram? This private link takes about a minute, and you can tell us there how we may use them:\n{upload_link}\n\nThank you!\n{sender}, {brand}',
  false,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("name") DO NOTHING;

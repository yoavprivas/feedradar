# Supabase database trust certificate

`supabase-ca.crt` is the public Supabase CA downloaded during initial setup from
https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt.
It is not a private key or application credential. The runtime Docker stage
includes it through the existing backend directory copy. Cloud deployment sets
DATABASE_CA_FILE to /app/backend/certs/supabase-ca.crt; certificate and hostname
verification remain mandatory. A successful application-role TLS connection was
verified on 2026-11-10 after SSL enforcement was enabled.

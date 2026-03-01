ALTER TABLE desktop_installations DROP CONSTRAINT IF EXISTS desktop_installations_tenant_id_fkey;
ALTER TABLE desktop_installations ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE desktop_installations
  ADD CONSTRAINT desktop_installations_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL;

ALTER TABLE pairing_codes DROP CONSTRAINT IF EXISTS pairing_codes_tenant_id_fkey;
ALTER TABLE pairing_codes ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE pairing_codes
  ADD CONSTRAINT pairing_codes_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL;

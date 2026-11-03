-- AddForeignKey
ALTER TABLE "ticket_upgrades" ADD CONSTRAINT "ticket_upgrades_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

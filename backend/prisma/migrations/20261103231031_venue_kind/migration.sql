-- CreateEnum
CREATE TYPE "VenueKind" AS ENUM ('STAGE', 'HALL', 'STADIUM', 'COURSE', 'EXPO', 'OPEN_AIR');

-- AlterTable
ALTER TABLE "events" ADD COLUMN     "venue_kind" "VenueKind" NOT NULL DEFAULT 'STAGE';

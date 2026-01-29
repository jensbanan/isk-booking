/*
  # Create bookings table for meeting room system

  1. New Tables
    - `bookings`
      - `id` (text, primary key) - composite key: room__date__startMins
      - `room` (text) - meeting room name
      - `date` (text) - ISO date string (YYYY-MM-DD)
      - `start_mins` (integer) - start time in minutes from midnight
      - `name` (text) - name of person who made the booking
      - `created_at` (timestamptz) - when booking was created
      - `updated_at` (timestamptz) - when booking was last updated

  2. Security
    - Enable RLS on `bookings` table
    - Add policy for anyone to read bookings (public booking system)
    - Add policy for anyone to create bookings
    - Add policy for anyone to delete bookings (self-service system)
    
  3. Indexes
    - Index on room for faster queries
    - Index on date for faster queries
*/

CREATE TABLE IF NOT EXISTS bookings (
  id text PRIMARY KEY,
  room text NOT NULL,
  date text NOT NULL,
  start_mins integer NOT NULL,
  name text NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bookings_room ON bookings(room);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);

ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view bookings"
  ON bookings
  FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Anyone can create bookings"
  ON bookings
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Anyone can delete bookings"
  ON bookings
  FOR DELETE
  TO anon, authenticated
  USING (true);
# WorkManager's database (CheckWorker) is created by Room through reflection, by its no-argument constructor; R8 drops
# that constructor otherwise and the app dies at start in androidx.startup.
-keep class * extends androidx.room.RoomDatabase { <init>(); }
